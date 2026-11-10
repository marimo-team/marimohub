import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthorizationService, createServices } from '@marimo-hub/core';
import type { UserId } from '@marimo-hub/core';
import { NotebookSource, SearchIndexer, SearchService } from '@marimo-hub/core/search';
import { MemorySearchIndex } from '@marimo-hub/core/testing/search';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeFakeCompute } from '@marimo-hub/core/testing';
import { queuedBackgroundWork } from '@marimo-hub/core/testing/background-work';
import { createTestApi, expectOk } from '../index';
import type { PolicyConfig } from '../../context';
import { RoundTripBucket } from './roundTripBucket';
import type { StorageCost } from './roundTripBucket';
import { ALICE, OWNER, USERS, seed } from './seed';
import type { Seeded } from './seed';

type Api = ReturnType<typeof makeApi>;

const READY_OPTIONS = { sessionIndex: 'on' } as const;

function makeApi(s: Seeded, userId: UserId, index: MemorySearchIndex, ready = false) {
	const background = queuedBackgroundWork();
	const bucket = new RoundTripBucket(s.bucket);
	const services = createServices(
		bucket,
		undefined,
		ready ? { ...READY_OPTIONS, backgroundWork: background.work } : undefined,
	);
	const policy: PolicyConfig = { maxConcurrentSessionsPerUser: 20 };
	const authz = new AuthorizationService(policy);
	const source = new NotebookSource(bucket, services.catalog, services.notebooks, authz);
	const search = {
		service: new SearchService(index, [source], services.catalog, services.projects, authz),
		indexer: new SearchIndexer(bucket, index, [source], services.catalog, services.projects),
	};
	const api = createTestApi({
		bucket: s.bucket,
		userId,
		compute: makeFakeCompute(),
		deps: { bucket, services, policy, backgroundWork: background.work, search },
	});
	return { ...api, measuredBucket: bucket, background, editSession: '' };
}

async function buildSearch(s: Seeded) {
	const index = new MemorySearchIndex();
	const services = createServices(s.bucket);
	const source = new NotebookSource(
		s.bucket,
		services.catalog,
		services.notebooks,
		new AuthorizationService({}),
	);
	const indexer = new SearchIndexer(s.bucket, index, [source], services.catalog, services.projects);
	const signal = new AbortController().signal;
	for (const project of s.projects) {
		let complete = false;
		for (let page = 0; page < 500 && !complete; page++) {
			complete = await indexer.step(project.id, source, signal);
		}
		expect(complete).toBe(true);
	}
	return index;
}

async function startEditor(a: Api, s: Seeded) {
	const data = await expectOk<{ session_id: string }>(
		await a.request('POST', `${nbBase(s)}/sessions`),
	);
	a.editSession = data.session_id;
	await a.background.runAll();
}

interface Endpoint {
	name: string;
	user?: UserId;
	/** Runs on a fresh api before the cold call; its ops are discarded. */
	setup?: (api: Api, s: Seeded) => Promise<void>;
	call: (api: Api, s: Seeded, i: number) => Response | Promise<unknown>;
}

const nbBase = (s: Seeded, nid = s.nid) => `/projects/${s.pid}/notebooks/${nid}`;

const ENDPOINTS: Endpoint[] = [
	{ name: 'GET /me', call: (a) => a.request('GET', '/me') },
	{
		name: 'GET /me (erin: app-user in every project)',
		user: USERS.erin,
		call: (a) => a.request('GET', '/me'),
	},
	{ name: 'GET /projects', call: (a) => a.request('GET', '/projects') },
	{ name: 'GET /projects (owner of all)', user: OWNER, call: (a) => a.request('GET', '/projects') },
	{ name: 'GET /projects/{pid}', call: (a, s) => a.request('GET', `/projects/${s.pid}`) },
	{
		name: 'GET /projects/{pid}/notebooks',
		call: (a, s) => a.request('GET', `/projects/${s.pid}/notebooks`),
	},
	{ name: 'GET /projects/{pid}/notebooks/{nid}', call: (a, s) => a.request('GET', nbBase(s)) },
	{
		name: 'GET …/notebooks/{nid}/content',
		call: (a, s) => a.request('GET', `${nbBase(s)}/content`),
	},
	{
		name: 'GET /apps?project_id=&limit=20',
		call: (a, s) => a.request('GET', `/apps?project_id=${s.pid}&limit=20`),
	},
	{ name: 'GET /apps?limit=20 (unscoped)', call: (a) => a.request('GET', '/apps?limit=20') },
	{
		name: 'GET /projects/{pid}/sessions',
		call: (a, s) => a.request('GET', `/projects/${s.pid}/sessions`),
	},
	{
		name: 'GET /projects/{pid}/thumbnails',
		call: (a, s) => a.request('GET', `/projects/${s.pid}/thumbnails`),
	},
	{
		name: 'GET …/notebooks/{nid}/thumbnail',
		call: (a, s) => a.request('GET', `${nbBase(s)}/thumbnail`),
	},
	{ name: 'GET /search?q=revenue', call: (a) => a.request('GET', '/search?q=revenue&limit=20') },
	{
		name: 'GET /search?q=&project_id=',
		call: (a, s) => a.request('GET', `/search?q=revenue&project_id=${s.pid}`),
	},
	{
		name: 'POST …/sessions (edit; cold=create, warm=reuse)',
		call: async (a, s) => {
			const res = await a.request('POST', `${nbBase(s)}/sessions`);
			const body = (await res.clone().json()) as { data?: { session_id?: string } };
			expect(body.data?.session_id).toBeTruthy();
			return res;
		},
	},
	{
		name: 'POST …/sessions (edit; new notebook each call)',
		call: (a, s, i) => {
			return a.request('POST', `${nbBase(s, s.projects[0].notebooks[i])}/sessions`);
		},
	},
	{
		name: 'GET …/sessions/{sid}',
		setup: startEditor,
		call: (a, s) => a.request('GET', `${nbBase(s)}/sessions/${a.editSession}`),
	},
	{
		name: 'POST …/sessions/{sid}/heartbeat (edit)',
		setup: startEditor,
		call: (a, s) => a.request('POST', `${nbBase(s)}/sessions/${a.editSession}/heartbeat`),
	},
	{
		name: 'PATCH …/notebooks/{nid} {code} (no live editor)',
		call: (a, s, i) => a.request('PATCH', nbBase(s, s.saveNid), { code: `x = ${i}\n` }),
	},
	{
		name: 'periodic save: notebooks.commitSession (live editor)',
		setup: startEditor,
		call: (a, s, i) =>
			a.deps.services.notebooks.commitSession(s.pid, s.nid, { code: `y = ${i}\n` }, ALICE),
	},
	{
		name: 'POST …/sessions (app; cold=admit, warm=re-admit)',
		user: USERS.erin,
		call: (a, s) =>
			a.request('POST', `${nbBase(s, s.projects[0].notebooks[3])}/sessions`, {
				mode: 'app',
				app_visit_id: 'bench-tab',
			}),
	},
];

async function measure(
	api: Api,
	call: () => Response | Promise<unknown>,
	isSearch: boolean,
	verify?: (data: unknown) => void,
) {
	const foreground = await api.measuredBucket.measure(async () => {
		const result = await call();
		if (result instanceof Response) {
			const data = await expectOk<{ items: unknown[]; coverage: { status: string }[] }>(result);
			verify?.(data);
			if (isSearch) {
				expect(data.items.length).toBeGreaterThan(0);
				expect(data.coverage.map((c) => c.status)).not.toContain('timeout');
			}
		} else expect(result).toBeDefined();
	});
	const background = await api.measuredBucket.measure(() => api.background.runAll());
	return { foreground: foreground.cost, background: background.cost };
}

function formatRounds(counts: number[]) {
	const runs: { count: number; repeat: number }[] = [];
	for (const count of counts) {
		const last = runs.at(-1);
		if (last?.count === count) last.repeat++;
		else runs.push({ count, repeat: 1 });
	}
	return (
		runs
			.map(({ count, repeat }) => (repeat === 1 ? String(count) : `${count}×${repeat}`))
			.join(', ') || '—'
	);
}

function row(endpoint: string, state: string, phase: string, cost: StorageCost) {
	const operations =
		Object.entries(cost.byOperation)
			.filter(([, count]) => count > 0)
			.map(([kind, count]) => `${kind}: ${count}`)
			.join(', ') || '—';
	return `| ${endpoint} | ${state} | ${phase} | ${cost.requests} | ${cost.rounds} | ${cost.estimatedMs} | ${operations} | ${formatRounds(cost.requestsPerRound)} |`;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test.each([
	{ name: 'small', projects: 5, notebooks: 10, ready: false },
	{ name: 'steady.small', projects: 5, notebooks: 10, ready: true },
	{ name: 'large', projects: 200, notebooks: 50, ready: false },
	{ name: 'steady.large', projects: 200, notebooks: 50, ready: true },
])(
	'$name endpoint storage costs',
	async (scale) => {
		// Freeze expiry/heartbeat decisions without faking the I/O scheduler.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
		// WebCrypto's worker-thread scheduling is CPU latency, not a storage dependency.
		vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
			const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
			const bytes = ArrayBuffer.isView(data)
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data);
			return Uint8Array.from(
				createHash(name.toLowerCase().replaceAll('-', '')).update(bytes).digest(),
			).buffer;
		});
		const seeded = await seed(scale.projects, scale.notebooks, { terminalSessions: 2000 });
		if (scale.ready) {
			const services = createServices(seeded.bucket, undefined, READY_OPTIONS);
			await services.sessions.rebuildSessionIndex();
			let batches = 0;
			while (!(await services.migrations.tick())) {
				expect(++batches).toBeLessThanOrEqual(scale.projects);
			}
		}
		const index = new MemorySearchIndex();
		for (const user of [OWNER, ...Object.values(USERS)]) {
			const api = makeApi(seeded, user, index, scale.ready);
			await expectOk(await api.request('GET', '/me'));
			await api.background.runAll();
		}
		const objects: { key: string; body: Uint8Array }[] = [];
		let cursor: string | undefined;
		do {
			const page = await seeded.bucket.list({ cursor });
			for (const object of page.objects) {
				objects.push({
					key: object.key,
					body: await (await seeded.bucket.get(object.key))!.bytes(),
				});
			}
			cursor = page.cursor;
		} while (cursor);
		const lines = [
			`# Endpoint storage costs: ${scale.name}`,
			'',
			`${scale.projects} projects × ${scale.notebooks} notebooks; 2,000 terminal + 5 live sessions.`,
			'Each call costs one simulated round trip of 25 ms. CPU, compute and network transfer time are excluded.',
			'Rounds include the first I/O round. Calls/round lists parallel widths in order; 16×3 means three rounds of 16 calls.',
			'Cold uses fresh services; warm repeats on the same services. Each scenario starts from an independent copy of the fixture.',
			'',
			...(scale.ready
				? [
						'Session index: on and backfilled. Access summaries: refreshed with matching generation. Core deferred work: enabled.',
						'',
					]
				: []),
			'<!-- prettier-ignore -->',
			'| Endpoint/scenario | Cache | Work | Storage calls | Rounds | Est. ms @25ms | Operations | Calls/round |',
			'| --- | --- | --- | ---: | ---: | ---: | --- | --- |',
		];
		const endpoints: Endpoint[] = scale.ready
			? [
					...ENDPOINTS,
					{
						name: 'POST …/sessions (edit; existing claimed editor)',
						setup: startEditor,
						call: async (a, s) => {
							const response = await a.request('POST', `${nbBase(s)}/sessions`);
							const body = (await response.clone().json()) as { data: { session_id: string } };
							expect(body.data.session_id).toBe(a.editSession);
							return response;
						},
					},
					{
						name: 'periodic save: unchanged code (live editor)',
						setup: async (a, s) => {
							await startEditor(a, s);
							await a.deps.services.notebooks.commitSession(
								s.pid,
								s.nid,
								{ code: 'unchanged = 1\n' },
								ALICE,
							);
							await a.background.runAll();
						},
						call: (a, s) =>
							a.deps.services.notebooks.commitSession(
								s.pid,
								s.nid,
								{ code: 'unchanged = 1\n' },
								ALICE,
							),
					},
				]
			: ENDPOINTS;
		for (const endpoint of endpoints) {
			const bucket = new MemoryBucket();
			for (const object of objects) await bucket.put(object.key, object.body);
			const s = { ...seeded, bucket };
			const isSearch = endpoint.name.startsWith('GET /search');
			// Search fingerprints include ETags, which change when the fixture is copied.
			const scenarioIndex = isSearch ? await buildSearch(s) : index;
			const setupApi = makeApi(s, endpoint.user ?? ALICE, scenarioIndex, scale.ready);
			await endpoint.setup?.(setupApi, s);
			const api = makeApi(s, endpoint.user ?? ALICE, scenarioIndex, scale.ready);
			api.editSession = setupApi.editSession;
			for (const [i, state] of ['cold', 'warm'].entries()) {
				const costs = await measure(
					api,
					() => endpoint.call(api, s, i),
					isSearch,
					(data) => {
						if (endpoint.name.startsWith('GET /me')) {
							expect((data as { app_only: boolean }).app_only).toBe(endpoint.user === USERS.erin);
						}
						if (
							endpoint.name === 'GET /projects' ||
							endpoint.name === 'GET /projects (owner of all)'
						) {
							const expected = s.projects
								.filter((_, index) => endpoint.user === OWNER || index % 4 < 2)
								.map((p) => p.id)
								.sort()
								.reverse()
								.slice(0, 100);
							expect((data as { items: { id: string }[] }).items.map((p) => p.id)).toEqual(
								expected,
							);
						}
					},
				);
				lines.push(row(endpoint.name, state, 'response', costs.foreground));
				lines.push(row(endpoint.name, state, 'deferred', costs.background));
			}
		}
		await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(`./endpoint-costs.${scale.name}.md`);
	},
	60_000,
);
