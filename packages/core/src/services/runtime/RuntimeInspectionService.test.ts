import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import {
	ACTOR,
	makeLocalSource,
	makeSession,
	makeSnapshotNotebookEntry,
	makeSnapshotProjectEntry,
} from '../../testing/fixtures';
import {
	createNotebookId,
	createProjectId,
	createSandboxId,
	createSessionId,
	createVersionId,
	UserId,
} from '../../ids';
import { paths } from '../../paths';
import { CatalogService } from '../catalog/CatalogService';
import { SessionService } from './SessionService';
import { AppPoolStore } from './AppPoolStore';
import { AppPoolService } from './AppPoolService';
import { DEFAULT_APP_POOL_POLICY } from './AppPoolRouter';
import type { AppPool, AppPoolMember } from './AppPoolRouter';
import { RuntimeInspectionService } from './RuntimeInspectionService';

describe('runtime inspection', () => {
	const pid = createProjectId();
	const nid = createNotebookId();
	const v1 = createVersionId();
	const v2 = createVersionId();
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let catalog: CatalogService;
	let store: AppPoolStore;
	let inspection: RuntimeInspectionService;
	let now: number;

	beforeEach(async () => {
		now = Date.parse('2026-09-16T12:00:00Z');
		bucket = new MemoryBucket();
		catalog = new CatalogService(bucket);
		await catalog.initialize(ACTOR);
		await catalog.mutateSnapshot('test', ACTOR, (snapshot) => ({
			...snapshot,
			projects: [
				makeSnapshotProjectEntry({
					id: pid,
					name: 'Analytics',
					notebooks: [makeSnapshotNotebookEntry(pid, { id: nid, title: 'Sales' })],
				}),
			],
		}));
		await bucket.put(paths.project(pid).notebook(nid).source, JSON.stringify(makeLocalSource(v1)));
		sessions = new SessionService(bucket);
		store = new AppPoolStore(bucket);
		inspection = new RuntimeInspectionService(bucket, sessions, catalog, () => now);
	});

	function member(overrides: Partial<AppPoolMember> = {}): AppPoolMember {
		return {
			session_id: createSessionId(),
			sandbox_id: createSandboxId(),
			user_id: ACTOR,
			source_version_id: v1,
			state: 'ready',
			created_at: now - 60_000,
			operation_token: 'private-operation',
			operation_expires_at: now + 60_000,
			...overrides,
		};
	}

	async function savePool(members: AppPoolMember[], assignments: AppPool['assignments'] = []) {
		await store.mutate(pid, nid, () => ({
			pool: { schema_version: 1, latest_version_id: v1, members, assignments },
			value: undefined,
		}));
	}

	async function saveSession(m: AppPoolMember, overrides: Parameters<typeof makeSession>[0] = {}) {
		const session = makeSession({
			project_id: pid,
			notebook_id: nid,
			session_id: m.session_id,
			sandbox_id: m.sandbox_id,
			source_version_id: m.source_version_id,
			mode: 'app',
			app_pool: true,
			...overrides,
		});
		await bucket.put(paths.session(pid, m.session_id), JSON.stringify(session));
		return session;
	}

	it('shows packing and rollover without moving existing accounts', async () => {
		const pool = new AppPoolService(
			bucket,
			sessions,
			{ ...DEFAULT_APP_POOL_POLICY, maxUsersPerSession: 4 },
			undefined,
			() => now,
		);
		const admit = async (user: string, versionId = v1) => {
			const admission = await pool.admit({
				projectId: pid,
				notebookId: nid,
				userId: UserId.parse(user),
				versionId,
				startupMs: 60_000,
			});
			if (admission.member.state === 'starting') {
				await saveSession(admission.member);
				await pool.complete(
					pid,
					nid,
					admission.member.session_id,
					admission.member.operation_token,
				);
			}
			return admission;
		};
		const first = await admit('one');
		for (const user of ['two', 'three', 'four']) await admit(user);
		const second = await admit('five');
		await bucket.put(paths.project(pid).notebook(nid).source, JSON.stringify(makeLocalSource(v2)));
		const third = await admit('six', v2);
		const snapshot = await inspection.inspect();
		expect(snapshot.incomplete).toBe(false);
		expect(snapshot.apps[0]).toMatchObject({
			project_name: 'Analytics',
			notebook_title: 'Sales',
			current_version_id: v2,
			current_version_members: 1,
		});
		const byId = new Map(
			snapshot.apps[0].sandboxes.map((sandbox) => [sandbox.session_id, sandbox]),
		);
		expect(byId.get(first.member.session_id)).toMatchObject({
			users: 4,
			version_status: 'old',
			pool_state: 'draining',
		});
		expect(byId.get(second.member.session_id)).toMatchObject({ users: 1, version_status: 'old' });
		expect(byId.get(third.member.session_id)).toMatchObject({
			users: 1,
			version_status: 'current',
		});
	});

	it('counts accounts, keeps grace, drops expired visits, and never persists inspection', async () => {
		const m = member();
		await saveSession(m);
		await savePool(
			[m],
			[
				{
					user_id: ACTOR,
					session_id: m.session_id,
					generation: 'secret-generation',
					visits: [
						{ visit_id: 'one', expires_at: now + 1000 },
						{ visit_id: 'two', expires_at: now + 2000 },
						{ visit_id: 'expired', expires_at: now },
					],
				},
				{
					user_id: UserId.parse('grace'),
					session_id: m.session_id,
					generation: 'g',
					visits: [],
					grace_until: now + 5000,
				},
				{
					user_id: UserId.parse('gone'),
					session_id: m.session_id,
					generation: 'g',
					visits: [{ visit_id: 'gone', expires_at: now - 1 }],
				},
			],
		);
		const original = await (await bucket.get(paths.appPool(pid, nid)))!.text();
		const put = vi.spyOn(bucket, 'put');
		const remove = vi.spyOn(bucket, 'delete');
		const snapshot = await inspection.inspect();
		const sandbox = snapshot.apps[0].sandboxes[0];
		expect(sandbox.users).toBe(2);
		expect(sandbox.assignments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ user_id: ACTOR, visits: 2, state: 'active' }),
				expect.objectContaining({ user_id: 'grace', visits: 0, state: 'grace' }),
			]),
		);
		expect(JSON.stringify(snapshot)).not.toMatch(
			/secret-generation|private-operation|visit_id|sandbox_url|kernel_auth_token/,
		);
		expect(put).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(await (await bucket.get(paths.appPool(pid, nid)))!.text()).toBe(original);
	});

	it('compares against the committed head even before pool rollover and while editing', async () => {
		const m = member();
		const older = member({ source_version_id: createVersionId(), state: 'draining' });
		await savePool([m, older]);
		await saveSession(m);
		await saveSession(older);
		await saveSession(member(), { mode: 'edit', app_pool: undefined });
		await bucket.put(paths.project(pid).notebook(nid).source, JSON.stringify(makeLocalSource(v2)));
		const snapshot = await inspection.inspect();
		expect(snapshot.apps[0].sandboxes.map((sandbox) => sandbox.version_status)).toEqual([
			'old',
			'old',
		]);
		expect(snapshot.apps[0].current_version_members).toBe(0);
		expect(snapshot.editors).toHaveLength(1);
		expect(snapshot.editors[0].source_version_id).toBe(v1);
	});

	it('includes reservations, retirement tombstones, and legacy sessions without double counting', async () => {
		const pending = member({ state: 'starting' });
		const retiring = member({ state: 'retiring' });
		const legacy = member({ legacy: true });
		await savePool([pending, retiring, legacy]);
		await saveSession(retiring, { status: 'terminated' });
		await saveSession(legacy, { app_pool: undefined });
		await saveSession(member(), { app_pool: undefined, source_version_id: undefined });
		const snapshot = await inspection.inspect();
		expect(snapshot.apps[0].sandboxes).toHaveLength(4);
		expect(
			snapshot.apps[0].sandboxes.find((sandbox) => sandbox.session_id === pending.session_id),
		).toMatchObject({ status: null, users: 0, pool_state: 'starting', incomplete: false });
		expect(
			snapshot.apps[0].sandboxes
				.filter((sandbox) => sandbox.legacy)
				.map((sandbox) => sandbox.users),
		).toEqual([null, null]);
		expect(
			snapshot.apps[0].sandboxes.find((sandbox) => sandbox.pool_state === 'retiring')?.status,
		).toBe('terminated');
		await store.retireForDeletion(pid, nid);
		now += 30_000;
		expect((await inspection.inspect()).apps[0].sandboxes).toHaveLength(4);
	});

	it('marks missing source, session and corrupt pool data incomplete without hiding other results', async () => {
		const m = member();
		await savePool([m]);
		const other = createNotebookId();
		await bucket.put(paths.appPool(pid, other), 'invalid json');
		await saveSession(member(), { notebook_id: other });
		await bucket.delete(paths.project(pid).notebook(nid).source);
		await bucket.put(paths.session(pid, createSessionId()), 'invalid json');
		const snapshot = await inspection.inspect();
		expect(snapshot.incomplete).toBe(true);
		expect(snapshot.apps).toHaveLength(2);
		expect(snapshot.apps.find((app) => app.notebook_id === nid)?.sandboxes[0]).toMatchObject({
			version_status: 'unknown',
			incomplete: true,
		});
		expect(snapshot.apps.find((app) => app.notebook_id === other)).toMatchObject({
			notebook_title: other,
			incomplete: true,
			sandboxes: [expect.objectContaining({ users: null })],
		});
	});

	it('shares concurrent scans for 30 seconds and reads each source, session and pool only once', async () => {
		const a = member();
		const b = member();
		await savePool([a, b]);
		await saveSession(a);
		await saveSession(b);
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');
		const snapshots = await Promise.all(Array.from({ length: 10 }, () => inspection.inspect()));
		expect(new Set(snapshots).size).toBe(1);
		expect(
			list.mock.calls
				.map(([options]) => options?.prefix)
				.sort((a, b) => (a ?? '').localeCompare(b ?? '')),
		).toEqual([paths.appPoolsPrefix, paths.sessionsPrefix].sort((a, b) => a.localeCompare(b)));
		const keys = get.mock.calls.map(([key]) => key);
		expect(keys).toHaveLength(6); // catalog pointer + snapshot + pool + source + two sessions
		expect(new Set(keys).size).toBe(keys.length);
		now += 29_999;
		await inspection.inspect();
		expect(get).toHaveBeenCalledTimes(6);
		now++;
		const refreshed = await inspection.inspect();
		expect(get).toHaveBeenCalledTimes(12);
		expect(refreshed.observed_at).not.toBe(snapshots[0].observed_at);
	});

	it('uses the expired assignment deadline for idle age and leaves unknown idle age unset', async () => {
		const empty = member();
		const expired = member();
		await saveSession(empty);
		await saveSession(expired);
		await savePool(
			[empty, expired],
			[
				{
					user_id: ACTOR,
					session_id: expired.session_id,
					generation: 'g',
					visits: [{ visit_id: 'gone', expires_at: now - 10_000 }],
				},
			],
		);
		const snapshot = await inspection.inspect();
		expect(
			snapshot.apps[0].sandboxes.find((sandbox) => sandbox.session_id === empty.session_id)
				?.idle_since,
		).toBeNull();
		expect(
			snapshot.apps[0].sandboxes.find((sandbox) => sandbox.session_id === expired.session_id),
		).toMatchObject({ users: 0, idle_since: new Date(now - 10_000).toISOString() });
	});

	it('paginates discovery and reports per-record read failures without discarding healthy records', async () => {
		const good = member();
		const unavailable = member();
		await savePool([good, unavailable]);
		await saveSession(good);
		await saveSession(unavailable);
		const secondNotebook = createNotebookId();
		await store.mutate(pid, secondNotebook, (pool) => ({
			pool: { ...pool, members: [member({ state: 'starting' })] },
			value: undefined,
		}));
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementation((options) => list({ ...options, limit: 1 }));
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key === paths.session(pid, unavailable.session_id)) throw new Error('read unavailable');
			if (key === paths.appPool(pid, secondNotebook)) return null;
			return get(key);
		});
		const snapshot = await inspection.inspect();
		expect(snapshot.incomplete).toBe(true);
		expect(snapshot.apps).toHaveLength(2);
		expect(snapshot.apps.find((app) => app.notebook_id === nid)?.sandboxes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ session_id: good.session_id, incomplete: false }),
				expect.objectContaining({ session_id: unavailable.session_id, incomplete: true }),
			]),
		);
		expect(snapshot.apps.find((app) => app.notebook_id === secondNotebook)).toMatchObject({
			incomplete: true,
			sandboxes: [],
		});
	});

	it('retries a failed scan and does not cache it as an empty snapshot', async () => {
		vi.spyOn(bucket, 'list').mockRejectedValueOnce(new Error('unavailable'));
		await expect(inspection.inspect()).rejects.toThrow('unavailable');
		expect((await inspection.inspect()).apps).toEqual([]);
	});
	it.each(['missing', 'invalid', 'read failure'])(
		'keeps occupancy but reports an unknown version when the source is %s',
		async (failure) => {
			const m = member();
			await savePool([m]);
			await saveSession(m);
			const key = paths.project(pid).notebook(nid).source;
			if (failure === 'missing') await bucket.delete(key);
			else if (failure === 'invalid') await bucket.put(key, '{"type":"unsupported"}');
			else {
				const get = bucket.get.bind(bucket);
				vi.spyOn(bucket, 'get').mockImplementation((requested) =>
					requested === key ? Promise.reject(new Error('unavailable')) : get(requested),
				);
			}
			const snapshot = await inspection.inspect();
			expect(snapshot.apps[0]).toMatchObject({
				current_version_id: null,
				current_version_members: null,
				incomplete: true,
				sandboxes: [expect.objectContaining({ users: 0, version_status: 'unknown' })],
			});
		},
	);

	it('falls back to IDs when the catalog cannot be read and recovers on the next refresh', async () => {
		const m = member();
		await savePool([m]);
		await saveSession(m);
		const read = vi
			.spyOn(catalog, 'getCurrentSnapshot')
			.mockRejectedValueOnce(new Error('catalog offline'));
		const partial = await inspection.inspect();
		expect(partial).toMatchObject({
			incomplete: true,
			apps: [
				expect.objectContaining({
					project_name: pid,
					notebook_title: nid,
					current_version_members: 1,
				}),
			],
		});
		now += 30_000;
		const recovered = await inspection.inspect();
		expect(recovered).toMatchObject({
			incomplete: false,
			apps: [expect.objectContaining({ project_name: 'Analytics', notebook_title: 'Sales' })],
		});
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('shares failed refreshes, preserves the previous snapshot, and retries after failure', async () => {
		const m = member();
		await savePool([m]);
		await saveSession(m);
		const previous = await inspection.inspect();
		const original = structuredClone(previous);
		now += 30_000;
		const list = vi.spyOn(bucket, 'list').mockRejectedValueOnce(new Error('listing unavailable'));
		const failures = await Promise.allSettled(
			Array.from({ length: 8 }, () => inspection.inspect()),
		);
		expect(failures.every((result) => result.status === 'rejected')).toBe(true);
		expect(list).toHaveBeenCalledTimes(2);
		expect(previous).toEqual(original);
		await bucket.put(paths.project(pid).notebook(nid).source, JSON.stringify(makeLocalSource(v2)));
		const recovered = await inspection.inspect();
		expect(recovered.observed_at).not.toBe(previous.observed_at);
		expect(recovered.apps[0].sandboxes[0].version_status).toBe('old');
	});

	it('keeps caches isolated between deployments', async () => {
		await savePool([member({ state: 'starting' })]);
		const otherBucket = new MemoryBucket();
		const otherCatalog = new CatalogService(otherBucket);
		await otherCatalog.initialize(ACTOR);
		const other = new RuntimeInspectionService(
			otherBucket,
			new SessionService(otherBucket),
			otherCatalog,
			() => now,
		);
		const [first, second] = await Promise.all([inspection.inspect(), other.inspect()]);
		expect(first.apps).toHaveLength(1);
		expect(second.apps).toEqual([]);
	});

	it('ignores malformed pool paths without rereading a valid pool through an alias', async () => {
		const m = member({ state: 'starting' });
		await savePool([m]);
		const key = paths.appPool(pid, nid);
		const malformed = [
			`${key}/nested.json`,
			key.replace('.json', ''),
			`${paths.appPoolsPrefix}not-a-project/${nid}.json`,
		];
		for (const invalid of malformed) await bucket.put(invalid, '{}');
		const get = vi.spyOn(bucket, 'get');
		const snapshot = await inspection.inspect();
		expect(snapshot.incomplete).toBe(true);
		expect(snapshot.apps).toHaveLength(1);
		expect(get.mock.calls.filter(([requested]) => requested === key)).toHaveLength(1);
		for (const invalid of malformed) expect(get).not.toHaveBeenCalledWith(invalid);
	});

	it('expires grace at its exact boundary and never renews an assignment during inspection', async () => {
		const m = member();
		await savePool(
			[m],
			[{ user_id: ACTOR, session_id: m.session_id, generation: 'g', visits: [], grace_until: now }],
		);
		await saveSession(m);
		const put = vi.spyOn(bucket, 'put');
		expect((await inspection.inspect()).apps[0].sandboxes[0]).toMatchObject({
			users: 0,
			assignments: [],
			idle_since: new Date(now).toISOString(),
		});
		expect(put).not.toHaveBeenCalled();
	});

	it('uses member metadata when session metadata is absent, while preserving recorded zero connections', async () => {
		const m = member();
		await savePool([m]);
		await saveSession(m, {
			source_version_id: undefined,
			sandbox_id: undefined,
			active_connections: 0,
		});
		expect((await inspection.inspect()).apps[0].sandboxes[0]).toMatchObject({
			source_version_id: v1,
			sandbox_id: m.sandbox_id,
			active_connections: 0,
			version_status: 'current',
		});
	});

	it('excludes reclaimed pools and terminal sessions, while treating absent mode as an editor', async () => {
		await savePool([]);
		await store.retireForDeletion(pid, nid);
		await saveSession(member(), { status: 'terminated' });
		await saveSession(member(), { mode: 'edit', status: 'failed' });
		const editor = await saveSession(member(), { mode: undefined, app_pool: undefined });
		const snapshot = await inspection.inspect();
		expect(snapshot.apps).toEqual([]);
		expect(snapshot.editors.map((session) => session.session_id)).toEqual([editor.session_id]);
	});
	it.each(['created_at', 'idle_since', 'visit'] as const)(
		'marks a pool with an invalid %s timestamp incomplete instead of failing the whole snapshot',
		async (field) => {
			const m = member(field === 'visit' ? {} : { [field]: Number.MAX_VALUE });
			await saveSession(m);
			await savePool(
				[m],
				[
					{
						user_id: ACTOR,
						session_id: m.session_id,
						generation: 'g',
						visits: [
							{ visit_id: 'tab', expires_at: field === 'visit' ? Number.MAX_VALUE : now - 1 },
						],
					},
				],
			);
			const snapshot = await inspection.inspect();
			expect(snapshot).toMatchObject({
				incomplete: true,
				apps: [
					expect.objectContaining({
						current_version_members: null,
						incomplete: true,
						sandboxes: [expect.objectContaining({ status: 'running', users: null })],
					}),
				],
			});
		},
	);
});
