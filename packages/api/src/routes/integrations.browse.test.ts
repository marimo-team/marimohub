import { beforeEach, describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import {
	AesGcmSecretCodec,
	defaultRegistry,
	defineIntegration,
	IntegrationRegistry,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
	UnavailableError,
	zSecret,
} from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const codec = new AesGcmSecretCodec({ kek: '/ECMzY/eM7nlHPPNu+OM2wv0lWiFuHUScSJxNmh64N8=' });

/** U+001F, the separator multi-part namespaces use in query params. */
const SEP = String.fromCharCode(0x1f);

/** Browsable test kind; ops are network-free, so no probe traffic in tests. */
const browsyKind = defineIntegration({
	kind: 'browsy',
	title: 'Browsy',
	description: 'test kind',
	category: 'catalog',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({
		mode: z.enum(['open', 'sandbox_only']).default('open'),
		token: zSecret(),
	}),
	render: () => ({}),
	browse: {
		available: (config) =>
			config.mode === 'open' ? { ok: true } : { ok: false, reason: 'sandbox only' },
		// Echo the inputs so route tests can assert round-trips.
		listNamespaces: async (_config, _probe, request) => ({
			items: [['sales', 'eu.central'], ...(request.parent ? [request.parent] : [])],
			next_cursor: request.cursor ?? 'next-token',
		}),
		listTables: async (_config, _probe, namespace) => {
			// Simulated outage, so route tests can exercise the failure path.
			if (namespace[0] === 'boom') throw new UnavailableError('The catalog answered HTTP 503.');
			return { items: [namespace.join('|')], next_cursor: null };
		},
		getTableSchema: async (_config, _probe, _namespace, table) => ({
			columns: [{ name: `${table}_id`, type: 'long', nullable: false }],
		}),
		previewRows: async (_config, _probe, namespace, table, request) => ({
			columns: ['qualified', 'limit'],
			rows: [[`${namespace.join('.')}.${table}`, request.limit]],
		}),
		snippet: (name, namespace, table) => `load ${name}:${namespace.join('.')}.${table}`,
	},
});

const sandboxBrowsyKind = defineIntegration({
	kind: 'sandbox_browsy',
	title: 'Sandbox browsy',
	description: 'test kind with sandbox preview',
	category: 'catalog',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({}),
	render: () => ({ env: { SANDBOX_BROWSY: 'enabled' } }),
	browse: {
		available: () => ({ ok: true }),
		listNamespaces: async () => ({ items: [['sales']], next_cursor: null }),
		listTables: async () => ({ items: ['orders'], next_cursor: null }),
		getTableSchema: async () => ({ columns: [] }),
		snippet: () => 'load',
	},
});

function browserDeps(bucket: MemoryBucket) {
	const registry = new IntegrationRegistry();
	registry.register(browsyKind);
	registry.register(sandboxBrowsyKind);
	for (const def of defaultRegistry().list()) registry.register(def);
	const stubProbe = { fetch: () => Promise.reject(new Error('no network in tests')) };
	const options = { bucket, registry, codec, probe: stubProbe, browseProbe: stubProbe };
	return {
		integrations: new ProjectIntegrationsStore(options),
		orgIntegrations: new OrgIntegrationsStore(options),
		dataBrowser: { preview: false },
	};
}

describe('Data browser routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];
	let deps: ReturnType<typeof browserDeps>;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		deps = browserDeps(bucket);
		request = createTestApi({ bucket, userId: ACTOR, deps }).request;
	});

	async function createProject() {
		const data = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'P', description: 'd' }),
			201,
		);
		return data.id;
	}

	async function createBrowsable(pid: string, name = 'lake') {
		return expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name,
				config: { token: 'tok' },
			}),
			201,
		);
	}

	it('404s when the data browser is not wired', async () => {
		const { dataBrowser: _unused, ...withoutBrowser } = deps;
		const bare = createTestApi({ bucket, userId: ACTOR, deps: withoutBrowser }).request;
		const pid = await createProject();
		const created = await createBrowsable(pid);
		await expectError(
			await bare('GET', `/projects/${pid}/integrations/${created.id}/browse`),
			404,
			'NOT_FOUND',
		);
	});

	it('reports the instance capability, with preview off', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/browse`),
		);
		expect(capability).toEqual({ metadata: true, preview: false });

		const closed = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'browsy',
				name: 'closed',
				config: { mode: 'sandbox_only', token: 'tok' },
			}),
			201,
		);
		const closedCapability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${closed.id}/browse`),
		);
		expect(closedCapability).toEqual({ metadata: false, preview: false, reason: 'sandbox only' });
	});

	it('previews rows on demand with no-store and appends an audit event', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		deps.dataBrowser.preview = true;

		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/browse`),
		);
		expect(capability).toEqual({ metadata: true, preview: true });

		const response = await request(
			'POST',
			`/projects/${pid}/integrations/${created.id}/browse/preview`,
			{ namespace: ['sales'], table: 'orders', limit: 7 },
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await expectOk(response)).toEqual({
			columns: ['qualified', 'limit'],
			rows: [['sales.orders', 7]],
		});

		const events = await expectOk<{ event: string; table?: string }[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events).toContainEqual(expect.objectContaining({ event: 'integration.preview' }));
	});

	it('passes the authenticated email as the native browse identity', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		deps.dataBrowser.preview = true;
		const captured: unknown[] = [];
		const original = deps.integrations.browseTablePreview.bind(deps.integrations);
		deps.integrations.browseTablePreview = (async (...args: Parameters<typeof original>) => {
			captured.push(args.at(-1));
			return original(...args);
		}) as typeof original;

		await expectOk(
			await request('POST', `/projects/${pid}/integrations/${created.id}/browse/preview`, {
				namespace: ['sales'],
				table: 'orders',
			}),
		);
		expect(captured).toEqual([{ limit: 20, query_user: `${ACTOR}@example.com` }]);
	});

	it('renders only the selected integration for the sandbox preview fallback', async () => {
		const pid = await createProject();
		await createBrowsable(pid, 'other');
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'selected',
				config: {},
			}),
			201,
		);
		const calls: unknown[] = [];
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...deps,
				dataBrowser: {
					preview: true,
					sandboxPreview: {
						available: () => true,
						check: async () => {},
						preview: async (input) => {
							calls.push(input);
							return { columns: ['id'], rows: [[1]] };
						},
					},
				},
			},
		}).request;

		const response = await full(
			'POST',
			`/projects/${pid}/integrations/${selected.id}/browse/preview`,
			{ namespace: ['sales'], table: 'orders', limit: 3 },
		);
		expect(await expectOk(response)).toEqual({ columns: ['id'], rows: [[1]] });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			integration_name: 'selected',
			user_id: ACTOR,
			bundle: {
				vars: expect.objectContaining({ SANDBOX_BROWSY: 'enabled' }),
				attachments: [{ name: 'selected', kind: 'sandbox_browsy' }],
			},
		});
	});

	it('advertises a sandbox preview only after the runtime is ready', async () => {
		const pid = await createProject();
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'preview-gated',
				config: {},
			}),
			201,
		);
		let ready = false;
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...deps,
				dataBrowser: {
					preview: true,
					sandboxPreview: {
						available: () => ready,
						check: async () => {
							ready = true;
						},
						preview: async () => ({ columns: [], rows: [] }),
					},
				},
			},
		}).request;
		const url = `/projects/${pid}/integrations/${selected.id}/browse`;

		expect(await expectOk(await full('GET', url))).toEqual({ metadata: true, preview: false });
		ready = true;
		expect(await expectOk(await full('GET', url))).toEqual({ metadata: true, preview: true });
	});

	it('injects project WIF credentials into sandbox previews', async () => {
		const pid = await createProject();
		await expectOk(await request('PATCH', `/projects/${pid}`, { federation: { enabled: true } }));
		const selected = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'sandbox_browsy',
				name: 'selected-wif',
				config: {},
			}),
			201,
		);
		const calls: unknown[] = [];
		const full = createTestApi({
			bucket,
			userId: ACTOR,
			deps: {
				...deps,
				wif: {
					issuer: { mint: async () => 'jwt', jwks: async () => ({ keys: [] }) } as never,
					issuerUrl: 'https://hub.example.com',
					target: {
						broker: {
							exchange: async () => ({
								accessKeyId: 'temporary-key',
								secretAccessKey: 'temporary-secret',
								sessionToken: 'temporary-token',
							}),
						},
						storage: { region: 'us-east-1' },
						audience: 'storage',
					},
				},
				dataBrowser: {
					preview: true,
					sandboxPreview: {
						available: () => true,
						check: async () => {},
						preview: async (input) => {
							calls.push(input);
							return { columns: [], rows: [] };
						},
					},
				},
			},
		}).request;

		await expectOk(
			await full('POST', `/projects/${pid}/integrations/${selected.id}/browse/preview`, {
				namespace: ['sales'],
				table: 'orders',
			}),
		);
		expect(calls[0]).toMatchObject({
			credential_vars: {
				AWS_ACCESS_KEY_ID: 'temporary-key',
				AWS_SECRET_ACCESS_KEY: 'temporary-secret',
				AWS_SESSION_TOKEN: 'temporary-token',
				AWS_REGION: 'us-east-1',
			},
		});
	});

	it('editor can browse; viewer cannot', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const editor = uid('user_editor');
		const viewer = uid('user_viewer');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: editor, role: 'editor' }),
			201,
		);
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: viewer, role: 'viewer' }),
			201,
		);

		const asEditor = createTestApi({ bucket, userId: editor, deps }).request;
		const namespaces = await expectOk<{ items: string[][] }>(
			await asEditor('GET', `/projects/${pid}/integrations/${created.id}/browse/namespaces`),
		);
		expect(namespaces.items).toContainEqual(['sales', 'eu.central']);

		const asViewer = createTestApi({ bucket, userId: viewer, deps }).request;
		await expectError(
			await asViewer('GET', `/projects/${pid}/integrations/${created.id}/browse/namespaces`),
			403,
			'FORBIDDEN',
		);
		await expectError(
			await asViewer('GET', `/projects/${pid}/integrations/${created.id}/browse`),
			403,
			'FORBIDDEN',
		);
	});

	it('round-trips dotted namespace parts and cursors through the query params', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse`;

		const parent = encodeURIComponent(['a.b', 'c'].join(SEP));
		const namespaces = await expectOk<{ items: string[][]; next_cursor: string | null }>(
			await request('GET', `${base}/namespaces?parent=${parent}&cursor=page-2&limit=5`),
		);
		expect(namespaces.items).toContainEqual(['a.b', 'c']);
		expect(namespaces.next_cursor).toBe('page-2');

		const tables = await expectOk<{ items: string[] }>(
			await request('GET', `${base}/tables?namespace=${parent}`),
		);
		expect(tables.items).toEqual(['a.b|c']);

		const schema = await expectOk<Record<string, unknown>>(
			await request('GET', `${base}/schema?namespace=sales&table=orders`),
		);
		expect(schema).toEqual({
			columns: [{ name: 'orders_id', type: 'long', nullable: false }],
			snippet: 'load lake:sales.orders',
		});
	});

	it('422s an instance whose kind cannot browse, with the reason on the capability', async () => {
		const pid = await createProject();
		const pg = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'pg',
				config: { host: 'db.internal', database: 'analytics', username: 'svc', password: 'pw' },
			}),
			201,
		);
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${pg.id}/browse/tables?namespace=s`),
			422,
			'VALIDATION_ERROR',
		);
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${pg.id}/browse`),
		);
		expect(capability).toMatchObject({
			metadata: false,
			reason: expect.stringContaining('does not support browsing'),
		});
	});

	it('serves repeat lookups from the cache and enforces the per-user budget', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const rateUser = uid('user_browse_rate');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: rateUser, role: 'editor' }),
			201,
		);
		const asRateUser = createTestApi({ bucket, userId: rateUser, deps }).request;
		const base = `/projects/${pid}/integrations/${created.id}/browse`;

		// The same lookup repeated is a cache hit and never exhausts the budget.
		for (let i = 0; i < 40; i++) {
			await expectOk(await asRateUser('GET', `${base}/tables?namespace=cached`));
		}

		// Distinct lookups are misses; the budget refuses within the minute.
		let limited = 0;
		for (let i = 0; i < 21; i++) {
			const res = await asRateUser('GET', `${base}/tables?namespace=ns-${i}`);
			if (res.status === 429) limited += 1;
		}
		expect(limited).toBeGreaterThan(0);
	});

	it('a warm cache entry stops serving once the instance is shadowed or disabled', async () => {
		const root = uid('user_cache_root');
		const rootApi = createTestApi({
			bucket,
			userId: root,
			deps: { ...deps, policy: { superAdmins: [root] } },
		});
		const orgInstance = await expectOk<{ id: string }>(
			await rootApi.request('POST', '/org/integrations', {
				kind: 'browsy',
				name: 'cached-lake',
				config: { token: 'org-tok' },
			}),
			201,
		);
		const pid = await createProject();
		const orgUrl = `/projects/${pid}/integrations/${orgInstance.id}/browse/tables?namespace=warm`;
		await expectOk(await request('GET', orgUrl));

		// Shadowing must take effect immediately, not after the TTL.
		await createBrowsable(pid, 'cached-lake');
		await expectError(await request('GET', orgUrl), 404, 'NOT_FOUND');

		const project = await createBrowsable(pid, 'own-lake');
		const projectUrl = `/projects/${pid}/integrations/${project.id}/browse/tables?namespace=warm`;
		await expectOk(await request('GET', projectUrl));
		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${project.id}`, { enabled: false }),
		);
		await expectError(await request('GET', projectUrl), 422, 'VALIDATION_ERROR');
	});

	it('fresh=true bypasses the cache read but still refreshes the entry', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse`;

		// Wrap the store method to count how often the cache actually misses.
		let storeCalls = 0;
		const original = deps.integrations.browseTables.bind(deps.integrations);
		deps.integrations.browseTables = (async (...args: Parameters<typeof original>) => {
			storeCalls += 1;
			return original(...args);
		}) as typeof original;

		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check`));
		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check`));
		expect(storeCalls).toBe(1);

		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check&fresh=true`));
		expect(storeCalls).toBe(2);

		// The fresh result refreshed the cache: a plain lookup hits it again.
		await expectOk(await request('GET', `${base}/tables?namespace=fresh-check`));
		expect(storeCalls).toBe(2);
	});

	// The schema response embeds the instance name in its snippet, and a rename
	// bumps only the head — never the config version.
	it('a rename invalidates warm schema responses', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/schema?namespace=sales&table=orders`;

		const before = await expectOk<{ snippet?: string }>(await request('GET', url));
		expect(before.snippet).toBe('load lake:sales.orders');

		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, { name: 'lagoon' }),
		);

		const after = await expectOk<{ snippet?: string }>(await request('GET', url));
		expect(after.snippet).toBe('load lagoon:sales.orders');
	});

	it('an unknown integration id answers 404 on every browse route', async () => {
		const pid = await createProject();
		const ghost = 'intg-7h2k9qm4xz7rp3w8';
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${ghost}/browse`),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${ghost}/browse/tables?namespace=s`),
			404,
			'NOT_FOUND',
		);
	});

	it('rejects malformed browse query params with 422', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const base = `/projects/${pid}/integrations/${created.id}/browse`;
		for (const bad of [
			`${base}/namespaces?limit=0`,
			`${base}/namespaces?limit=501`,
			`${base}/tables?namespace=`,
			`${base}/tables`,
			`${base}/tables?namespace=s&fresh=nah`,
			`${base}/schema?namespace=s`,
			// Empty identifier parts (bare/leading/trailing joiner) — no catalog
			// can hold them, so they must not spend an upstream request.
			`${base}/tables?namespace=%1F`,
			`${base}/tables?namespace=s%1F`,
			`${base}/namespaces?parent=%1Fs`,
		]) {
			await expectError(await request('GET', bad), 422, 'VALIDATION_ERROR');
		}
	});

	// Each caller still pays its own budget for the miss; only the upstream
	// probe traffic is shared.
	it('concurrent identical lookups share one upstream load', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/tables?namespace=fanin`;

		let storeCalls = 0;
		const original = deps.integrations.browseTables.bind(deps.integrations);
		deps.integrations.browseTables = (async (...args: Parameters<typeof original>) => {
			storeCalls += 1;
			// Hold the load open so the other requests arrive while it is in flight.
			await new Promise((resolve) => setTimeout(resolve, 20));
			return original(...args);
		}) as typeof original;

		const responses = await Promise.all([
			request('GET', url),
			request('GET', url),
			request('GET', url),
		]);
		for (const res of responses) expect(res.status).toBe(200);
		expect(storeCalls).toBe(1);
	});

	it('maps an upstream outage to 503 and never caches the failure', async () => {
		const pid = await createProject();
		const created = await createBrowsable(pid);
		const url = `/projects/${pid}/integrations/${created.id}/browse/tables?namespace=boom`;

		let storeCalls = 0;
		const original = deps.integrations.browseTables.bind(deps.integrations);
		deps.integrations.browseTables = (async (...args: Parameters<typeof original>) => {
			storeCalls += 1;
			return original(...args);
		}) as typeof original;

		await expectError(await request('GET', url), 503, 'SERVICE_UNAVAILABLE');
		await expectError(await request('GET', url), 503, 'SERVICE_UNAVAILABLE');
		// Both requests reached the store: an outage is retried, not remembered.
		expect(storeCalls).toBe(2);
	});

	it('an org instance is browsable through the project until shadowed', async () => {
		const root = uid('user_browse_root');
		const rootApi = createTestApi({
			bucket,
			userId: root,
			deps: { ...deps, policy: { superAdmins: [root] } },
		});
		const orgInstance = await expectOk<{ id: string }>(
			await rootApi.request('POST', '/org/integrations', {
				kind: 'browsy',
				name: 'shared-lake',
				config: { token: 'org-tok' },
			}),
			201,
		);

		const pid = await createProject();
		const capability = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${orgInstance.id}/browse`),
		);
		expect(capability).toEqual({ metadata: true, preview: false });

		await createBrowsable(pid, 'shared-lake');
		await expectError(
			await request('GET', `/projects/${pid}/integrations/${orgInstance.id}/browse`),
			404,
			'NOT_FOUND',
		);
	});
});
