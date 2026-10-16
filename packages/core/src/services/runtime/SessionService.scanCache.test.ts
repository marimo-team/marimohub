import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EtagRecordCache } from '../../etagRecordCache';
import { createNotebookId, createProjectId } from '../../ids';
import { paths } from '../../paths';
import type { Session } from '../../schema';
import { ACTOR, advanceTime, restoreClock } from '../../testing';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { RecordingBucket } from '../../testing/RecordingBucket';
import { SessionService } from './SessionService';

describe('SessionService scan cache', () => {
	let bucket: RecordingBucket;
	let sessions: SessionService;
	let cache: EtagRecordCache<Session>;
	const projects = [createProjectId(), createProjectId()];

	beforeEach(() => {
		bucket = new RecordingBucket(new MemoryBucket());
		cache = new EtagRecordCache();
		sessions = new SessionService(bucket, undefined, cache);
	});
	afterEach(() => {
		restoreClock();
		vi.restoreAllMocks();
	});

	const create = (projectId = projects[0]) =>
		sessions.createSession({
			project_id: projectId,
			notebook_id: createNotebookId(),
			user_id: ACTOR,
		});
	const sessionGetsSince = (offset: number) =>
		bucket.calls.get.slice(offset).filter((key) => key.startsWith(paths.sessionsPrefix));

	it('makes the second scan list-only with identical results across two projects', async () => {
		for (let index = 0; index < 5; index++) await create(projects[index % 2]);
		const gets = bucket.calls.get.length;
		const lists = bucket.calls.list.length;
		const first = await sessions.listActiveForUser(ACTOR);
		expect(first).toHaveLength(5);
		expect(sessionGetsSince(gets)).toHaveLength(5);
		expect(bucket.calls.list).toHaveLength(lists + 1);
		const warmedGets = bucket.calls.get.length;
		expect(await sessions.listActiveForUser(ACTOR)).toEqual(first);
		expect(sessionGetsSince(warmedGets)).toEqual([]);
		expect(bucket.calls.list).toHaveLength(lists + 2);
		expect(await sessions.listActiveByProject(projects[0])).toHaveLength(3);
		expect(sessionGetsSince(warmedGets)).toEqual([]);
	});

	it('fetches only a changed record, including changes from another service instance', async () => {
		const changed = await create();
		await create(projects[1]);
		await sessions.listActiveForUser(ACTOR);
		await sessions.listActiveForUser(ACTOR);
		await new SessionService(bucket).setRunning(
			changed.project_id,
			changed.session_id,
			'https://sandbox.example',
		);
		const gets = bucket.calls.get.length;
		const result = await sessions.listActiveForUser(ACTOR);
		expect(sessionGetsSince(gets)).toEqual([paths.session(changed.project_id, changed.session_id)]);
		expect(result.find((session) => session.session_id === changed.session_id)?.status).toBe(
			'running',
		);
	});

	it.each(['cold', 'warm'] as const)(
		'isolates mutations of %s scan results from later reads and expiry writes',
		async (cacheState) => {
			const created = await sessions.createSession({
				project_id: projects[0],
				notebook_id: createNotebookId(),
				user_id: ACTOR,
				runtime: { python_version: '3.13' },
			});
			const expected = await sessions.getSession(created.project_id, created.session_id);
			if (cacheState === 'warm') await sessions.listSessions();
			const [returned] = await sessions.listSessions();
			returned.status = 'terminated';
			if (!returned.runtime) throw new Error('Expected session runtime');
			returned.runtime.python_version = '3.12';

			const gets = bucket.calls.get.length;
			expect(await sessions.listSessions()).toEqual([expected]);
			expect(await sessions.listActiveForUser(ACTOR)).toEqual([expected]);
			expect(await sessions.listByProject(created.project_id)).toEqual([expected]);
			expect(await sessions.listActiveByProject(created.project_id)).toEqual([expected]);
			expect(sessionGetsSince(gets)).toEqual([]);
			expect(await sessions.getSession(created.project_id, created.session_id)).toEqual(expected);

			advanceTime(6 * 60 * 1000);
			const expiryGets = bucket.calls.get.length;
			expect(await sessions.expireStale()).toBe(1);
			expect(sessionGetsSince(expiryGets)).toEqual([]);
			expect(await sessions.getSession(created.project_id, created.session_id)).toEqual({
				...expected,
				status: 'expired',
			});
		},
	);

	it('omits deleted records without retrying their GET', async () => {
		const deleted = await create();
		const survivor = await create();
		await sessions.listSessions();
		await bucket.delete(paths.session(deleted.project_id, deleted.session_id));
		const gets = bucket.calls.get.length;
		expect(await sessions.listSessions()).toEqual([survivor]);
		expect(await sessions.listSessions()).toEqual([survivor]);
		expect(sessionGetsSince(gets)).toEqual([]);
	});

	it('expires a stale session using the cached ETag for CAS', async () => {
		const session = await create();
		await sessions.setRunning(session.project_id, session.session_id, 'https://sandbox.example');
		advanceTime(6 * 60 * 1000);
		await sessions.listSessions();
		const gets = bucket.calls.get.length;
		expect(await sessions.expireStale()).toBe(1);
		expect(sessionGetsSince(gets)).toEqual([]);
		expect((await sessions.getSession(session.project_id, session.session_id)).status).toBe(
			'expired',
		);
	});

	it('caches the fetched ETag when a record changes after listing', async () => {
		const session = await create();
		const key = paths.session(session.project_id, session.session_id);
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementationOnce(async (options) => {
			const listed = await list(options);
			await bucket.put(key, JSON.stringify({ ...session, status: 'running' }));
			return listed;
		});
		expect((await sessions.listSessions())[0].status).toBe('running');
		const gets = bucket.calls.get.length;
		expect((await sessions.listSessions())[0].status).toBe('running');
		expect(sessionGetsSince(gets)).toEqual([]);
	});

	it('evicts a cached entry when a changed record disappears after listing', async () => {
		const session = await create();
		const key = paths.session(session.project_id, session.session_id);
		await sessions.listSessions();
		await bucket.put(key, JSON.stringify({ ...session, status: 'running' }));
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementationOnce(async (options) => {
			const listed = await list(options);
			await bucket.delete(key);
			return listed;
		});
		expect(await sessions.listSessions()).toEqual([]);
		expect(cache.size).toBe(0);
	});

	it('rejects a failed later listing page instead of returning cached partial results', async () => {
		const created = [await create(), await create(), await create()];
		const list = bucket.list.bind(bucket);
		const paginated = vi
			.spyOn(bucket, 'list')
			.mockImplementation((options) => list({ ...options, limit: 2 }));
		const first = await sessions.listSessions();
		expect(first).toHaveLength(created.length);
		const gets = bucket.calls.get.length;
		const error = new Error('second page unavailable');
		paginated
			.mockImplementationOnce((options) => list({ ...options, limit: 2 }))
			.mockRejectedValueOnce(error);
		await expect(sessions.listSessions()).rejects.toBe(error);
		expect(await sessions.listSessions()).toEqual(first);
		expect(sessionGetsSince(gets)).toEqual([]);
	});

	it('propagates GET failures instead of using a cached older version, then retries', async () => {
		const session = await create();
		await sessions.listSessions();
		await sessions.setRunning(session.project_id, session.session_id, 'https://sandbox.example');
		const error = new Error('storage unavailable');
		const get = vi.spyOn(bucket, 'get').mockRejectedValueOnce(error);
		await expect(sessions.listSessions()).rejects.toBe(error);
		expect((await sessions.listSessions())[0].status).toBe('running');
		expect(get).toHaveBeenCalledTimes(2);
		await sessions.listSessions();
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('preserves a concurrent heartbeat when expiry uses a cached stale ETag', async () => {
		const session = await create();
		const key = paths.session(session.project_id, session.session_id);
		advanceTime(6 * 60 * 1000);
		await sessions.listSessions();
		const gets = bucket.calls.get.length;
		const put = bucket.put.bind(bucket);
		const refreshed = { ...session, last_heartbeat: new Date().toISOString() };
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (writeKey, value, options) => {
			await put(key, JSON.stringify(refreshed));
			return put(writeKey, value, options);
		});
		expect(await sessions.expireStale()).toBe(0);
		expect(sessionGetsSince(gets)).toEqual([]);
		expect(await sessions.getSession(session.project_id, session.session_id)).toEqual(refreshed);
		expect(await sessions.expireStale()).toBe(0);
	});

	it('returns every record when the scan exceeds cache capacity', async () => {
		cache = new EtagRecordCache(1);
		sessions = new SessionService(bucket, undefined, cache);
		await create();
		await create();
		await create();
		const first = await sessions.listSessions();
		expect(first).toHaveLength(3);
		expect(cache.size).toBe(1);
		expect(await sessions.listSessions()).toEqual(first);
		expect(cache.size).toBe(1);
	});

	it('revalidates after an older in-flight read overwrites a newer cache entry', async () => {
		const session = await create();
		const key = paths.session(session.project_id, session.session_id);
		const get = bucket.get.bind(bucket);
		const fetched = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(bucket, 'get').mockImplementationOnce(async (readKey) => {
			const body = await get(readKey);
			fetched.resolve();
			await release.promise;
			return body;
		});
		const olderScan = sessions.listSessions();
		await fetched.promise;
		try {
			await bucket.put(key, JSON.stringify({ ...session, status: 'running' }));
			expect((await sessions.listSessions())[0].status).toBe('running');
		} finally {
			release.resolve();
			await olderScan;
		}
		const gets = bucket.calls.get.length;
		expect((await sessions.listSessions())[0].status).toBe('running');
		expect(sessionGetsSince(gets)).toEqual([key]);
	});

	it.each(['{}', '{invalid json'])(
		'retries corrupt records (%s) and recovers after repair',
		async (invalid) => {
			const session = await create();
			const key = paths.session(session.project_id, session.session_id);
			await sessions.listSessions();
			await bucket.put(key, invalid);
			const gets = bucket.calls.get.length;
			expect(await sessions.listSessions()).toEqual([]);
			expect(await sessions.listSessions()).toEqual([]);
			await expect(sessions.listByProject(session.project_id)).rejects.toThrow();
			expect(sessionGetsSince(gets)).toEqual([key, key, key]);
			await bucket.put(key, JSON.stringify(session));
			expect(await sessions.listByProject(session.project_id)).toEqual([session]);
			const repairedGets = bucket.calls.get.length;
			expect(await sessions.listSessions()).toEqual([session]);
			expect(sessionGetsSince(repairedGets)).toEqual([]);
		},
	);
});
