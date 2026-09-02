import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AesGcmSecretCodec,
	defaultRegistry,
	IntegrationId,
	OrgIntegrationsStore,
	paths,
	ProjectId,
	ProjectIntegrationsStore,
} from '@marimo-hub/core';
import type { IntegrationsStoreOptions, UserId } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { Page } from '../pagination';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { trackedTestBudgets } from './integrations';

const codec = new AesGcmSecretCodec({ kek: '/ECMzY/eM7nlHPPNu+OM2wv0lWiFuHUScSJxNmh64N8=' });

function integrationsDeps(bucket: MemoryBucket, extra: Partial<IntegrationsStoreOptions> = {}) {
	const options = { bucket, registry: defaultRegistry(), codec, ...extra };
	return {
		integrations: new ProjectIntegrationsStore(options),
		orgIntegrations: new OrgIntegrationsStore(options),
	};
}

const PG_CONFIG = {
	host: 'db.internal',
	database: 'analytics',
	username: 'svc',
	password: 'sup3r-secret',
};

describe('Integrations routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		request = createTestApi({ bucket, userId: ACTOR, deps: integrationsDeps(bucket) }).request;
	});

	async function createProject() {
		const data = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'P', description: 'd' }),
			201,
		);
		return data.id;
	}

	async function createPg(pid: string, name = 'prod') {
		return expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name,
				config: PG_CONFIG,
			}),
			201,
		);
	}

	it('lists kinds with serializable JSON Schemas and ui hints', async () => {
		const kinds = await expectOk<Record<string, unknown>[]>(
			await request('GET', '/integrations/kinds'),
		);
		// The shipped set is pinned by name in core's own registry test; what this
		// one adds is that every registered kind survives the route's serialization.
		expect(kinds.length).toBeGreaterThan(0);
		expect(kinds.map((k) => String(k.kind)).sort((a, b) => a.localeCompare(b))).toEqual(
			defaultRegistry()
				.list()
				.map((def) => def.kind)
				.sort((a, b) => a.localeCompare(b)),
		);
		const pg = kinds.find((k) => k.kind === 'postgres');
		expect(pg).toMatchObject({
			category: 'database',
			schema_version: 2,
			json_schema: { type: 'object' },
			browse_surfaces: [],
		});
		const s3 = kinds.find((k) => k.kind === 's3');
		expect(s3).toMatchObject({ supports_browse: false, browse_surfaces: [] });
	});

	it('create → get returns a redacted config; the plaintext never appears anywhere', async () => {
		const pid = await createProject();
		const created = await createPg(pid);

		const detail = await expectOk<Record<string, unknown>>(
			await request('GET', `/projects/${pid}/integrations/${created.id}`),
		);
		expect(detail).toMatchObject({
			kind: 'postgres',
			name: 'prod',
			enabled: true,
			current_version: 1,
			config: {
				host: 'db.internal',
				port: 5432, // schema default applied
				password: { $secret: { set: true } },
			},
		});
		expect(JSON.stringify(detail)).not.toContain('sup3r-secret');

		const events = await expectOk<Record<string, unknown>[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events.map((e) => e.event)).toContain('integration.create');
		expect(JSON.stringify(events)).not.toContain('sup3r-secret');
	});

	it('returns a sanitized 503 and logs safe diagnostics for malformed stored JSON', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		const key = paths
			.project(ProjectId.parse(pid))
			.integration(IntegrationId.parse(created.id)).head;
		await bucket.put(key, '{"password":"stored-secret-do-not-log"');
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		const res = await request('GET', `/projects/${pid}/integrations/${created.id}`);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(503);
		expect(body).toMatchObject({
			success: false,
			error: {
				code: 'SERVICE_UNAVAILABLE',
				message: 'Stored data is temporarily unavailable',
			},
		});
		expect(JSON.stringify(body)).not.toContain(key);
		expect(JSON.stringify(body)).not.toContain('stored-secret-do-not-log');
		const line = log.mock.calls[0]?.[0] as string;
		expect(line).toContain('StoredObjectError');
		expect(line).toContain('invalid_json');
		expect(line).toContain(key);
		expect(line).not.toContain('stored-secret-do-not-log');
	});

	it('update with config appends a version; keep-marker preserves the secret', async () => {
		const pid = await createProject();
		const created = await createPg(pid);

		const updated = await expectOk<Record<string, unknown>>(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				config: { ...PG_CONFIG, host: 'db2.internal', password: { $secret: { set: true } } },
				change_note: 'moved hosts',
			}),
		);
		expect(updated).toMatchObject({
			current_version: 2,
			config: { host: 'db2.internal', password: { $secret: { set: true } } },
			change_note: 'moved hosts',
		});

		const versions = await expectOk<{ items: { version: number }[]; next_cursor: string | null }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/versions`),
		);
		expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
		expect(versions.next_cursor).toBeNull();
	});

	it('never writes a replacement secret into the integration audit event', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		const replacement = 'replacement-secret-not-for-events';
		await expectOk(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				config: { ...PG_CONFIG, password: replacement },
			}),
		);

		const events = await expectOk<Record<string, unknown>[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events.map((event) => event.event)).toContain('integration.update');
		expect(JSON.stringify(events)).not.toContain(replacement);
	});

	it('keeps a committed write successful and logs when its audit append fails', async () => {
		const pid = await createProject();
		const local = createTestApi({ bucket, userId: ACTOR, deps: integrationsDeps(bucket) });
		vi.spyOn(local.deps.services.events, 'append').mockRejectedValue(
			new Error('storage credential do-not-log'),
		);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		const res = await local.request('POST', `/projects/${pid}/integrations`, {
			kind: 'postgres',
			name: 'audit-failure',
			config: PG_CONFIG,
		});

		expect(res.status).toBe(201);
		const line = log.mock.calls.find((call) =>
			String(call[0]).includes('audit_append'),
		)?.[0] as string;
		expect(line).toContain('best_effort_operation_failed');
		expect(line).toContain('integration.create');
		expect(line).not.toContain('do-not-log');
	});

	it('version history paginates newest-first with a cursor', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		for (const host of ['a.internal', 'b.internal', 'c.internal']) {
			await expectOk(
				await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
					config: { ...PG_CONFIG, host, password: { $secret: { set: true } } },
				}),
			);
		}
		const first = await expectOk<{ items: { version: number }[]; next_cursor: string | null }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}/versions?limit=2`),
		);
		expect(first.items.map((v) => v.version)).toEqual([4, 3]);
		expect(first.next_cursor).not.toBeNull();
		const rest = await expectOk<{ items: { version: number }[]; next_cursor: string | null }>(
			await request(
				'GET',
				`/projects/${pid}/integrations/${created.id}/versions?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
			),
		);
		expect(rest.items.map((v) => v.version)).toEqual([2, 1]);
	});

	it('PATCH rejects no-op payloads (422): {} and a change_note without config', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectError(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {}),
			422,
		);
		await expectError(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				change_note: 'orphan note',
			}),
			422,
		);
	});

	it('PATCH honors If-Match: stale token → 412, fresh ETag → 200', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectError(
			await request(
				'PATCH',
				`/projects/${pid}/integrations/${created.id}`,
				{ enabled: true },
				{ 'if-match': '"1999-01-01T00:00:00.000Z"' },
			),
			412,
		);
		const fresh = await expectOk<{ updated_at: string }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}`),
		);
		await expectOk(
			await request(
				'PATCH',
				`/projects/${pid}/integrations/${created.id}`,
				{ enabled: false },
				{ 'if-match': `"${fresh.updated_at}"` },
			),
		);
	});

	it('DELETE honors If-Match: stale token → 412, fresh ETag → 200', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectError(
			await request('DELETE', `/projects/${pid}/integrations/${created.id}`, undefined, {
				'if-match': '"1999-01-01T00:00:00.000Z"',
			}),
			412,
		);
		const fresh = await expectOk<{ updated_at: string }>(
			await request('GET', `/projects/${pid}/integrations/${created.id}`),
		);
		await expectOk(
			await request('DELETE', `/projects/${pid}/integrations/${created.id}`, undefined, {
				'if-match': `"${fresh.updated_at}"`,
			}),
		);
		await expectError(await request('GET', `/projects/${pid}/integrations/${created.id}`), 404);
	});

	it('enabled toggle and rename append no version', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		const updated = await expectOk<Record<string, unknown>>(
			await request('PATCH', `/projects/${pid}/integrations/${created.id}`, {
				enabled: false,
				name: 'staging',
			}),
		);
		expect(updated).toMatchObject({ enabled: false, name: 'staging', current_version: 1 });
	});

	it('rejects an unknown kind, a bad config, and a duplicate name (422)', async () => {
		const pid = await createProject();
		await expectError(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'nope',
				name: 'x',
				config: {},
			}),
			422,
		);
		await expectError(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'x',
				config: { host: 'h' }, // intentionally missing required fields
			}),
			422,
		);
		await createPg(pid);
		await expectError(
			await request('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'prod',
				config: PG_CONFIG,
			}),
			422,
		);
	});

	it('delete removes the instance and its history; idempotent', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectOk(await request('DELETE', `/projects/${pid}/integrations/${created.id}`));
		await expectOk(await request('DELETE', `/projects/${pid}/integrations/${created.id}`));
		expect(
			await expectOk<Page<unknown>>(await request('GET', `/projects/${pid}/integrations`)),
		).toEqual({ items: [], next_cursor: null });
		await expectError(await request('GET', `/projects/${pid}/integrations/${created.id}`), 404);
	});

	it('paginates project integration instances without duplicates', async () => {
		const pid = await createProject();
		for (const name of ['alpha', 'bravo', 'charlie']) await createPg(pid, name);

		const first = await expectOk<Page<{ id: string; scope: string }>>(
			await request('GET', `/projects/${pid}/integrations?limit=2`),
		);
		expect(first.items).toHaveLength(2);
		expect(first.items.every((entry) => entry.scope === 'project')).toBe(true);
		expect(first.next_cursor).not.toBeNull();

		const second = await expectOk<Page<{ id: string }>>(
			await request(
				'GET',
				`/projects/${pid}/integrations?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
			),
		);
		expect(second.items).toHaveLength(1);
		expect(second.next_cursor).toBeNull();
		expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(3);
	});

	it('list requires membership; create/update/delete/test require manager', async () => {
		const pid = await createProject();
		const editor = uid('user_editor');
		const manager = uid('user_manager');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: editor, role: 'editor' }),
			201,
		);
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: manager, role: 'manager' }),
			201,
		);
		const created = await createPg(pid);

		const editorReq = createTestApi({
			bucket,
			userId: editor,
			deps: integrationsDeps(bucket),
		}).request;
		const strangerReq = createTestApi({
			bucket,
			userId: uid('user_stranger'),
			deps: integrationsDeps(bucket),
		}).request;
		const managerReq = createTestApi({
			bucket,
			userId: manager,
			deps: integrationsDeps(bucket),
		}).request;

		await expectError(await strangerReq('GET', `/projects/${pid}/integrations`), 403);
		await expectError(await strangerReq('GET', `/projects/${pid}/integrations/${created.id}`), 403);
		await expectError(
			await strangerReq('GET', `/projects/${pid}/integrations/${created.id}/versions`),
			403,
		);
		await expectOk(await editorReq('GET', `/projects/${pid}/integrations`));
		await expectOk(await editorReq('GET', `/projects/${pid}/integrations/${created.id}`));
		await expectOk(await editorReq('GET', `/projects/${pid}/integrations/${created.id}/versions`));
		await expectError(
			await editorReq('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'nope',
				config: PG_CONFIG,
			}),
			403,
		);
		await expectError(
			await editorReq('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
			403,
		);
		await expectError(
			await editorReq('DELETE', `/projects/${pid}/integrations/${created.id}`),
			403,
		);
		await expectError(
			await editorReq('POST', `/projects/${pid}/integrations/test`, {
				source: 'stored',
				id: created.id,
			}),
			403,
		);
		await expectError(
			await editorReq('POST', `/projects/${pid}/integrations/query-readiness`, {
				kind: 'iceberg_rest',
				config: {},
			}),
			403,
		);

		const managed = await expectOk<{ id: string }>(
			await managerReq('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'managed',
				config: PG_CONFIG,
			}),
			201,
		);
		await expectOk(
			await managerReq('PATCH', `/projects/${pid}/integrations/${managed.id}`, {
				enabled: false,
			}),
		);
		await expectError(
			await managerReq('POST', `/projects/${pid}/integrations/test`, {
				source: 'stored',
				id: managed.id,
			}),
			422,
		);
		await expectOk(await managerReq('DELETE', `/projects/${pid}/integrations/${managed.id}`));
	});

	it('a super admin holds admin on a project they are not a member of', async () => {
		const pid = await createProject();
		const god = uid('user_god');
		const godReq = createTestApi({
			bucket,
			userId: god,
			deps: { ...integrationsDeps(bucket), policy: { superAdmins: [god] } },
		}).request;

		const created = await expectOk<{ id: string }>(
			await godReq('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'god-made',
				config: PG_CONFIG,
			}),
			201,
		);
		await expectOk(await godReq('GET', `/projects/${pid}/integrations`));
		await expectOk(await godReq('GET', `/projects/${pid}/integrations/${created.id}`));
		await expectOk(await godReq('GET', `/projects/${pid}/integrations/${created.id}/versions`));
		await expectOk(
			await godReq('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
		);
		await expectOk(await godReq('DELETE', `/projects/${pid}/integrations/${created.id}`));
	});

	it('404s every route once the project is soft-deleted — owner and super admin alike', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectOk(await request('DELETE', `/projects/${pid}`));

		const god = uid('user_god');
		for (const req of [
			request,
			createTestApi({
				bucket,
				userId: god,
				deps: { ...integrationsDeps(bucket), policy: { superAdmins: [god] } },
			}).request,
		]) {
			await expectError(await req('GET', `/projects/${pid}/integrations`), 404);
			await expectError(await req('GET', `/projects/${pid}/integrations/${created.id}`), 404);
			await expectError(
				await req('GET', `/projects/${pid}/integrations/${created.id}/versions`),
				404,
			);
			await expectError(
				await req('POST', `/projects/${pid}/integrations`, {
					kind: 'postgres',
					name: 'after',
					config: PG_CONFIG,
				}),
				404,
			);
			await expectError(
				await req('PATCH', `/projects/${pid}/integrations/${created.id}`, { enabled: false }),
				404,
			);
			await expectError(await req('DELETE', `/projects/${pid}/integrations/${created.id}`), 404);
			await expectError(
				await req('POST', `/projects/${pid}/integrations/test`, {
					source: 'stored',
					id: created.id,
				}),
				404,
			);
		}
	});

	it('does not resolve or probe an integration id through another project', async () => {
		const first = await createProject();
		const second = await createProject();
		const created = await createPg(first);

		await expectError(await request('GET', `/projects/${second}/integrations/${created.id}`), 404);
		await expectError(
			await request('POST', `/projects/${second}/integrations/test`, {
				source: 'stored',
				id: created.id,
			}),
			404,
		);
		expect(
			await expectOk<Page<unknown>>(await request('GET', `/projects/${second}/integrations`)),
		).toEqual({ items: [], next_cursor: null });
	});

	it('404s everywhere when the deployment has integrations disabled', async () => {
		const bare = createTestApi({ bucket, userId: ACTOR }).request;
		await expectError(await bare('GET', '/integrations/kinds'), 404);
		const pid = await createProject();
		const iid = 'intg-0000000000000000';
		await expectError(await bare('GET', `/projects/${pid}/integrations`), 404);
		await expectError(
			await bare('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'prod',
				config: PG_CONFIG,
			}),
			404,
		);
		await expectError(await bare('GET', `/projects/${pid}/integrations/${iid}`), 404);
		await expectError(
			await bare('PATCH', `/projects/${pid}/integrations/${iid}`, { enabled: false }),
			404,
		);
		await expectError(await bare('DELETE', `/projects/${pid}/integrations/${iid}`), 404);
		await expectError(await bare('GET', `/projects/${pid}/integrations/${iid}/versions`), 404);
		await expectError(
			await bare('POST', `/projects/${pid}/integrations/test`, {
				source: 'draft',
				kind: 'postgres',
				config: PG_CONFIG,
			}),
			404,
		);
	});

	it('capabilities reflects whether integrations are wired', async () => {
		const withIt = await expectOk<{ integrations: { available: boolean } }>(
			await request('GET', '/capabilities'),
		);
		expect(withIt.integrations.available).toBe(true);
		const without = createTestApi({ bucket, userId: ACTOR }).request;
		const caps = await expectOk<{ integrations: { available: boolean } }>(
			await without('GET', '/capabilities'),
		);
		expect(caps.integrations.available).toBe(false);
	});

	it('test on a kind without a probe explains itself (422)', async () => {
		const pid = await createProject();
		await expectError(
			await request('POST', `/projects/${pid}/integrations/test`, {
				source: 'draft',
				kind: 'postgres',
				config: PG_CONFIG,
			}),
			422,
		);
	});

	it('forwards the request signal to a database connection test', async () => {
		const pid = await createProject();
		const testConnection = vi.fn(async () => ({ ok: true, details: 'reachable' }));
		const wired = createTestApi({
			bucket,
			userId: ACTOR,
			deps: integrationsDeps(bucket, {
				probe: {
					fetch: () => Promise.reject(new Error('no network in tests')),
					connect: () => Promise.reject(new Error('no network in tests')),
				},
				databaseTesters: { postgres: { provider: 'postgres', testConnection } },
			}),
		}).request;

		await expectOk(
			await wired('POST', `/projects/${pid}/integrations/test`, {
				source: 'draft',
				kind: 'postgres',
				config: PG_CONFIG,
			}),
		);
		expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: 'postgres' }), {
			signal: expect.any(AbortSignal),
		});
	});

	it('returns every SQL readiness blocker without echoing draft secrets', async () => {
		const pid = await createProject();
		const secret = 'preflight-secret-must-not-return';
		const response = await request('POST', `/projects/${pid}/integrations/query-readiness`, {
			kind: 'iceberg_rest',
			config: {
				uri: 'https://catalog.example.com/api',
				auth: { method: 'bearer_token', token: secret },
				headers: { 'X-Custom': 'value' },
				extra_properties: { 'rest.custom-option': 'true' },
				storage: { scheme: 'catalog' },
			},
		});
		const checks =
			await expectOk<
				{ id: string; label: string; ready: boolean; field: string; reason: string }[]
			>(response);

		expect(checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'no-custom-headers',
					label: 'Remove custom headers',
					field: 'headers',
					ready: false,
				}),
				expect.objectContaining({
					id: 'no-extra-properties',
					label: 'Remove extra properties',
					field: 'extra_properties',
					ready: false,
				}),
			]),
		);
		expect(JSON.stringify(checks)).not.toContain(secret);
	});

	it('rejects invalid raw config before evaluating SQL readiness', async () => {
		const pid = await createProject();
		await expectError(
			await request('POST', `/projects/${pid}/integrations/query-readiness`, {
				kind: 'iceberg_rest',
				config: {
					uri: 'https://catalog.example.com/api',
					auth: { method: 'none' },
					access_delegation: 'none',
					storage: {
						scheme: 's3',
						endpoint: 'https://objects.example.com',
						anonymous: true,
						broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
					rest: { unsupported_option: true },
				},
			}),
			422,
		);
	});

	it('accepts a stored integration id when testing an edited draft', async () => {
		const pid = await createProject();
		const created = await createPg(pid);
		await expectError(
			await request('POST', `/projects/${pid}/integrations/test`, {
				source: 'draft',
				id: created.id,
				kind: 'postgres',
				config: {
					...PG_CONFIG,
					host: 'edited.internal',
					password: { $secret: { kind: 'managed', set: true } },
				},
			}),
			422,
		);
	});

	it.each([
		[
			'both stored and draft fields',
			{
				source: 'stored',
				id: 'intg-0000000000000000',
				kind: 'postgres',
				config: PG_CONFIG,
			},
		],
		['neither stored nor draft fields', {}],
		['an unknown discriminator', { source: 'unknown', kind: 'postgres', config: PG_CONFIG }],
		[
			'an extra draft field',
			{
				source: 'draft',
				kind: 'postgres',
				config: PG_CONFIG,
				unexpected: true,
			},
		],
		['an extra stored field', { source: 'stored', id: 'intg-0000000000000000', config: PG_CONFIG }],
	])('rejects integration test requests with %s', async (_label, body) => {
		const pid = await createProject();
		await expectError(await request('POST', `/projects/${pid}/integrations/test`, body), 422);
	});

	it('rate-limits connection tests per USER (429 after the budget)', async () => {
		const pid = await createProject();
		// A dedicated user so this test cannot eat other tests' budget (the
		// limiter is per-user within the process).
		const rateUser = uid('user_rate');
		await expectOk(
			await request('POST', `/projects/${pid}/members`, { user_id: rateUser, role: 'manager' }),
			201,
		);
		const rateReq = createTestApi({
			bucket,
			userId: rateUser,
			deps: integrationsDeps(bucket),
		}).request;

		const probeOnce = () =>
			rateReq('POST', `/projects/${pid}/integrations/test`, {
				source: 'draft',
				kind: 'postgres',
				config: PG_CONFIG,
			});
		// Each attempt consumes budget even when the kind cannot be tested (422).
		for (let i = 0; i < 10; i++) {
			await expectError(await probeOnce(), 422);
		}
		await expectError(await probeOnce(), 429);
	});

	it('one user exhausting the probe budget does not throttle another user', async () => {
		const pid = await createProject();
		const first = uid('user_rate_isolated_first');
		const second = uid('user_rate_isolated_second');
		for (const user_id of [first, second]) {
			await expectOk(
				await request('POST', `/projects/${pid}/members`, { user_id, role: 'manager' }),
				201,
			);
		}
		const firstReq = createTestApi({
			bucket,
			userId: first,
			deps: integrationsDeps(bucket),
		}).request;
		const secondReq = createTestApi({
			bucket,
			userId: second,
			deps: integrationsDeps(bucket),
		}).request;
		const body = { source: 'draft', kind: 'postgres', config: PG_CONFIG };

		for (let i = 0; i < 10; i++) {
			await expectError(await firstReq('POST', `/projects/${pid}/integrations/test`, body), 422);
		}
		await expectError(await firstReq('POST', `/projects/${pid}/integrations/test`, body), 429);
		await expectError(await secondReq('POST', `/projects/${pid}/integrations/test`, body), 422);
	});

	it('forgets probe budgets once their window expires', async () => {
		const pid = await createProject();
		const stale = uid('user_rate_stale');
		const active = uid('user_rate_active');
		for (const user_id of [stale, active]) {
			await expectOk(
				await request('POST', `/projects/${pid}/members`, { user_id, role: 'manager' }),
				201,
			);
		}
		const probe = (userId: UserId) =>
			createTestApi({ bucket, userId, deps: integrationsDeps(bucket) }).request(
				'POST',
				`/projects/${pid}/integrations/test`,
				{ source: 'draft', kind: 'postgres', config: PG_CONFIG },
			);

		// Only `Date` is faked: the request path still needs real timers.
		const base = Date.now();
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(base + 1_000);
			await expectError(await probe(stale), 422);
			vi.setSystemTime(base + 62_000);
			await expectError(await probe(active), 422);
			// Everyone from before the window is gone; only the live prober is held.
			expect(trackedTestBudgets()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Org integrations routes', () => {
	const ROOT = uid('user_root');
	let bucket: MemoryBucket;
	let deps: ReturnType<typeof integrationsDeps> & { policy: { superAdmins: string[] } };
	let asRoot: ReturnType<typeof createTestApi>['request'];
	let asUser: ReturnType<typeof createTestApi>['request'];
	let services: ReturnType<typeof createTestApi>['deps']['services'];

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		deps = { ...integrationsDeps(bucket), policy: { superAdmins: [ROOT] } };
		const rootApi = createTestApi({ bucket, userId: ROOT, deps });
		services = rootApi.deps.services;
		asRoot = rootApi.request;
		asUser = createTestApi({ bucket, userId: ACTOR, deps }).request;
	});

	async function createOrgPg(name = 'warehouse') {
		return expectOk<{ id: string }>(
			await asRoot('POST', '/org/integrations', { kind: 'postgres', name, config: PG_CONFIG }),
			201,
		);
	}

	it('every org route requires super admin (403 for everyone else)', async () => {
		const iid = 'intg-0000000000000000';
		await expectError(await asUser('GET', '/org/integrations'), 403);
		await expectError(
			await asUser('POST', '/org/integrations', {
				kind: 'postgres',
				name: 'warehouse',
				config: PG_CONFIG,
			}),
			403,
		);
		await expectError(await asUser('GET', `/org/integrations/${iid}`), 403);
		await expectError(await asUser('PATCH', `/org/integrations/${iid}`, { enabled: false }), 403);
		await expectError(await asUser('DELETE', `/org/integrations/${iid}`), 403);
		await expectError(await asUser('GET', `/org/integrations/${iid}/versions`), 403);
		await expectError(
			await asUser('POST', '/org/integrations/test', {
				source: 'draft',
				kind: 'postgres',
				config: PG_CONFIG,
			}),
			403,
		);
		await expectError(
			await asUser('POST', '/org/integrations/query-readiness', {
				kind: 'iceberg_rest',
				config: {},
			}),
			403,
		);
	});

	it('super admin CRUD round-trip: redaction, versions, ETag/If-Match, audit events', async () => {
		const created = await createOrgPg();

		const entries = await expectOk<Page<Record<string, unknown>>>(
			await asRoot('GET', '/org/integrations'),
		);
		expect(entries.items).toEqual([
			expect.objectContaining({ id: created.id, name: 'warehouse', scope: 'org' }),
		]);

		const res = await asRoot('GET', `/org/integrations/${created.id}`);
		const etag = res.headers.get('ETag');
		expect(etag).toBeTruthy();
		const detail = await expectOk<Record<string, unknown>>(res);
		expect(detail).toMatchObject({
			kind: 'postgres',
			scope: 'org',
			config: { host: 'db.internal', password: { $secret: { set: true } } },
		});
		expect(JSON.stringify(detail)).not.toContain('sup3r-secret');

		const updated = await expectOk<Record<string, unknown>>(
			await asRoot(
				'PATCH',
				`/org/integrations/${created.id}`,
				{ config: { ...PG_CONFIG, host: 'db2.internal', password: { $secret: { set: true } } } },
				{ 'If-Match': etag! },
			),
		);
		expect(updated.current_version).toBe(2);
		await expectError(
			await asRoot(
				'PATCH',
				`/org/integrations/${created.id}`,
				{ enabled: false },
				{ 'If-Match': etag! },
			),
			412,
		);
		// A stale delete must not erase the edit either.
		await expectError(
			await asRoot('DELETE', `/org/integrations/${created.id}`, undefined, { 'If-Match': etag! }),
			412,
		);

		const versions = await expectOk<{ items: { version: number }[] }>(
			await asRoot('GET', `/org/integrations/${created.id}/versions`),
		);
		expect(versions.items.map((v) => v.version)).toEqual([2, 1]);

		await expectOk(await asRoot('DELETE', `/org/integrations/${created.id}`));
		await expectError(await asRoot('GET', `/org/integrations/${created.id}`), 404);
		// The repeat is idempotent (200) but must not fabricate a second deletion.
		await expectOk(await asRoot('DELETE', `/org/integrations/${created.id}`));

		const events = await services.events.getEvents(new Date().toISOString().slice(0, 10));
		const names = events.map((e) => e.event);
		expect(names).toContain('integration.create');
		expect(names).toContain('integration.update');
		expect(names.filter((n) => n === 'integration.delete')).toHaveLength(1);
		expect(events.filter((event) => event.event.startsWith('integration.'))).toEqual(
			expect.arrayContaining([expect.objectContaining({ integration_scope: 'org' })]),
		);
		expect(JSON.stringify(events)).not.toContain('sup3r-secret');
	});

	it('project listings inherit org instances; a same-name project one marks them shadowed', async () => {
		await createOrgPg();
		const pid = (
			await expectOk<{ id: string }>(
				await asUser('POST', '/projects', { name: 'P', description: 'd' }),
				201,
			)
		).id;

		let page = await expectOk<Page<Record<string, unknown>>>(
			await asUser('GET', `/projects/${pid}/integrations`),
		);
		let entries = page.items;
		expect(entries).toEqual([expect.objectContaining({ name: 'warehouse', scope: 'org' })]);
		expect(entries[0]?.shadowed).toBeUndefined();

		await expectOk(
			await asUser('POST', `/projects/${pid}/integrations`, {
				kind: 'postgres',
				name: 'warehouse',
				config: PG_CONFIG,
			}),
			201,
		);
		page = await expectOk<Page<Record<string, unknown>>>(
			await asUser('GET', `/projects/${pid}/integrations`),
		);
		entries = page.items;
		expect(entries.map((e) => ({ scope: e.scope, shadowed: e.shadowed }))).toEqual([
			{ scope: 'project', shadowed: undefined },
			{ scope: 'org', shadowed: true },
		]);
		// The inherited entry is read-only through project routes.
		const orgId = String(entries[1]?.id);
		await expectError(await asUser('GET', `/projects/${pid}/integrations/${orgId}`), 404);
		await expectError(
			await asUser('PATCH', `/projects/${pid}/integrations/${orgId}`, { enabled: false }),
			404,
		);
		// A project-route delete of the org id is an idempotent no-op: 200, the org
		// instance survives, and no deletion enters the project's audit trail.
		await expectOk(await asUser('DELETE', `/projects/${pid}/integrations/${orgId}`));
		expect(await expectOk(await asRoot('GET', `/org/integrations/${orgId}`))).toMatchObject({
			name: 'warehouse',
		});
		const events = await expectOk<Record<string, unknown>[]>(
			await asUser('GET', `/projects/${pid}/events`),
		);
		expect(events.map((e) => e.event)).not.toContain('integration.delete');
	});

	it('404s (before the admin gate) when the deployment has integrations disabled', async () => {
		const bare = createTestApi({ bucket, userId: ROOT, deps: { policy: deps.policy } }).request;
		await expectError(await bare('GET', '/org/integrations'), 404);
		await expectError(
			await bare('POST', '/org/integrations', {
				kind: 'postgres',
				name: 'warehouse',
				config: PG_CONFIG,
			}),
			404,
		);
	});
});

describe('Integration copy route', () => {
	const ROOT = uid('user_import_root');
	const OUTSIDER = uid('user_import_outsider');
	const SOURCE_MANAGER = uid('user_import_source_manager');
	const MANAGER = uid('user_import_manager');
	let bucket: MemoryBucket;
	let deps: ReturnType<typeof integrationsDeps> & { policy: { superAdmins: string[] } };
	let asOwner: ReturnType<typeof createTestApi>['request'];
	let sourcePid: string;
	let targetPid: string;
	let sourceIid: string;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		deps = { ...integrationsDeps(bucket), policy: { superAdmins: [ROOT] } };
		asOwner = createTestApi({ bucket, userId: ACTOR, deps }).request;
		const createProject = async (name: string) =>
			(
				await expectOk<{ id: string }>(
					await asOwner('POST', '/projects', { name, description: 'd' }),
					201,
				)
			).id;
		sourcePid = await createProject('source');
		targetPid = await createProject('target');
		sourceIid = (
			await expectOk<{ id: string }>(
				await asOwner('POST', `/projects/${sourcePid}/integrations`, {
					kind: 'postgres',
					name: 'prod',
					config: PG_CONFIG,
				}),
				201,
			)
		).id;
	});

	const copyBody = (over: Record<string, unknown> = {}) => ({
		source_project_id: sourcePid,
		source_integration_id: sourceIid,
		...over,
	});

	it('manager of both projects copies the integration; secret fields stay redacted', async () => {
		for (const pid of [sourcePid, targetPid]) {
			await expectOk(
				await asOwner('POST', `/projects/${pid}/members`, {
					user_id: MANAGER,
					role: 'manager',
				}),
				201,
			);
		}
		const asManager = createTestApi({ bucket, userId: MANAGER, deps }).request;
		const detail = await expectOk<Record<string, unknown>>(
			await asManager('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			201,
		);
		expect(detail).toMatchObject({
			kind: 'postgres',
			name: 'prod',
			current_version: 1,
			config: { host: 'db.internal', password: { $secret: { set: true } } },
		});
		expect(detail.id).not.toBe(sourceIid);
		expect(JSON.stringify(detail)).not.toContain('sup3r-secret');

		const events = await expectOk<Record<string, unknown>[]>(
			await asManager('GET', `/projects/${targetPid}/events`),
		);
		const copied = events.find((e) => e.event === 'integration.copy');
		expect(copied).toMatchObject({
			source_project_id: sourcePid,
			source_integration_id: sourceIid,
		});
		expect(JSON.stringify(events)).not.toContain('sup3r-secret');
	});

	it('requires manager on BOTH projects — destination-only managers are refused', async () => {
		await expectOk(
			await asOwner('POST', `/projects/${targetPid}/members`, {
				user_id: OUTSIDER,
				role: 'manager',
			}),
			201,
		);
		// A manager of only the destination cannot even LEARN that the
		// source exists: an invisible source answers the same 404 as a missing one,
		// so the import route is not a project-id existence oracle.
		const asOutsider = createTestApi({ bucket, userId: OUTSIDER, deps }).request;
		await expectError(
			await asOutsider('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			404,
		);

		// Editor on the source can see it but still cannot export it: 403.
		await expectOk(
			await asOwner('POST', `/projects/${sourcePid}/members`, {
				user_id: OUTSIDER,
				role: 'editor',
			}),
			201,
		);
		await expectError(
			await asOutsider('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			403,
		);

		await expectOk(
			await asOwner('POST', `/projects/${sourcePid}/members`, {
				user_id: SOURCE_MANAGER,
				role: 'manager',
			}),
			201,
		);
		const asSourceManager = createTestApi({ bucket, userId: SOURCE_MANAGER, deps }).request;
		await expectError(
			await asSourceManager('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			403,
		);

		// A super admin who is a member of neither project passes both gates.
		const asRoot = createTestApi({ bucket, userId: ROOT, deps }).request;
		await expectOk(
			await asRoot('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			201,
		);
	});

	it('404s on unknown sources and 422s on a destination name conflict', async () => {
		await expectError(
			await asOwner(
				'POST',
				`/projects/${targetPid}/integrations/copy`,
				copyBody({ source_project_id: 'proj-0000000000000000' }),
			),
			404,
		);
		await expectError(
			await asOwner(
				'POST',
				`/projects/${targetPid}/integrations/copy`,
				copyBody({ source_integration_id: 'intg-0000000000000000' }),
			),
			404,
		);

		await expectOk(
			await asOwner('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			201,
		);
		await expectError(
			await asOwner('POST', `/projects/${targetPid}/integrations/copy`, copyBody()),
			422,
		);
		const renamed = await expectOk<Record<string, unknown>>(
			await asOwner(
				'POST',
				`/projects/${targetPid}/integrations/copy`,
				copyBody({ name: 'prod-copy' }),
			),
			201,
		);
		expect(renamed.name).toBe('prod-copy');
	});
});
