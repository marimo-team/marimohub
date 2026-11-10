import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR, uid } from '../../testing';
import { createNotebookId, createProjectId, createSessionId } from '../../ids';
import { paths } from '../../paths';
import { SessionService } from './SessionService';
import { SessionIndex } from './SessionIndex';
import { legacySessions } from '../../testing/legacy-sessions';

afterEach(() => vi.restoreAllMocks());

function fixture() {
	const bucket = new MemoryBucket();
	const input = { project_id: createProjectId(), notebook_id: createNotebookId(), user_id: ACTOR };
	const sessions = new SessionService(bucket, undefined, undefined, () => true);
	const legacy = legacySessions(bucket);
	return { bucket, input, sessions, legacy, index: new SessionIndex(bucket) };
}

describe('session index recovery', () => {
	it('distinguishes a missing index from an initialized empty index', async () => {
		const { index, sessions } = fixture();
		expect(await index.read(ACTOR)).toBeNull();
		expect(await sessions.listActiveForUser(ACTOR)).toEqual([]);
		expect(await index.read(ACTOR)).toEqual({ user_id: ACTOR, entries: [] });
	});

	it('recovers legacy sessions before ranking a new start', async () => {
		const { legacy, sessions, input, index } = fixture();
		const existing = await legacy.createSession(input);
		await legacy.setRunning(input.project_id, existing.session_id, 'https://kernel.example');
		const created = await sessions.createSession(input);
		expect((await sessions.listActiveForUser(ACTOR)).map((session) => session.session_id)).toEqual([
			existing.session_id,
			created.session_id,
		]);
		expect((await index.read(ACTOR))?.entries).toHaveLength(2);
	});

	it('merges concurrent first-time registrations with legacy occupants', async () => {
		const { bucket, legacy, sessions, input, index } = fixture();
		const incumbent = await legacy.createSession(input);
		await legacy.setRunning(input.project_id, incumbent.session_id, 'https://kernel.example');
		const bothInitialized = Promise.withResolvers<void>();
		const put = bucket.put.bind(bucket);
		let attempts = 0;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.sessionIndexForUser(ACTOR) && options?.onlyIfNotExists) {
				if (++attempts === 2) bothInitialized.resolve();
				await bothInitialized.promise;
			}
			return put(key, value, options);
		});
		const replica = new SessionService(bucket, undefined, undefined, () => true);
		const created = await Promise.all([
			sessions.createSession(input),
			replica.createSession(input),
		]);
		expect(attempts).toBe(2);
		const ids = [incumbent.session_id, ...created.map((session) => session.session_id)];
		expect((await index.read(ACTOR))?.entries.map((entry) => entry.session_id).sort()).toEqual(
			[...ids].sort(),
		);
		const ranked = await sessions.listActiveForUser(ACTOR);
		expect(ranked[0]?.session_id).toBe(incumbent.session_id);
		expect(await replica.listActiveForUser(ACTOR)).toEqual(ranked);
	});

	it('recovers a lost index without dropping existing cap occupants', async () => {
		const { bucket, sessions, input } = fixture();
		const existing = await sessions.createSession(input);
		await bucket.delete(paths.sessionIndexForUser(ACTOR));
		const cold = new SessionService(bucket, undefined, undefined, () => true);
		expect((await cold.listActiveForUser(ACTOR)).map((session) => session.session_id)).toEqual([
			existing.session_id,
		]);
	});

	it('does not scan or fetch other users on a cold replica with a healthy index', async () => {
		const { bucket, sessions, legacy, input } = fixture();
		const existing = await sessions.createSession(input);
		await legacy.createSession({ ...input, user_id: uid('unrelated') });
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');
		const cold = new SessionService(bucket, undefined, undefined, () => true);
		expect(await cold.countActiveForUser(ACTOR)).toBe(1);
		expect(list).not.toHaveBeenCalled();
		expect(get.mock.calls.map(([key]) => key)).toEqual([
			paths.sessionIndexForUser(ACTOR),
			paths.session(input.project_id, existing.session_id),
		]);
	});

	it('rejects registration when the index disappears after initialization', async () => {
		const { bucket, sessions, input, index } = fixture();
		await sessions.createSession(input);
		const get = bucket.get.bind(bucket);
		let deleted = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
			const record = await get(key, options);
			if (key === paths.sessionIndexForUser(ACTOR) && !deleted) {
				deleted = true;
				await bucket.delete(key);
			}
			return record;
		});
		const session_id = createSessionId();
		await expect(sessions.createSession({ ...input, session_id })).rejects.toThrow(
			'Session index is missing',
		);
		expect((await sessions.getSession(input.project_id, session_id)).status).toBe('failed');
		expect(await index.read(ACTOR)).toBeNull();
	});

	it.each(['list', 'get'] as const)('fails closed when recovery %s fails', async (operation) => {
		const { bucket, legacy, sessions, input, index } = fixture();
		const existing = await legacy.createSession(input);
		const error = new Error('recovery unavailable');
		if (operation === 'list') vi.spyOn(bucket, 'list').mockRejectedValue(error);
		else {
			const get = bucket.get.bind(bucket);
			vi.spyOn(bucket, 'get').mockImplementation((key, options) => {
				if (key === paths.session(input.project_id, existing.session_id)) throw error;
				return get(key, options);
			});
		}
		await expect(sessions.listActiveForUser(ACTOR)).rejects.toThrow('recovery unavailable');
		await expect(sessions.createSession(input)).rejects.toThrow('recovery unavailable');
		expect(await index.read(ACTOR)).toBeNull();
	});

	it('does not recreate an index lost during stale-reference cleanup', async () => {
		const { bucket, sessions, input, index } = fixture();
		const stale = await sessions.createSession(input);
		const live = await sessions.createSession(input);
		const staleKey = paths.session(input.project_id, stale.session_id);
		await bucket.put(staleKey, JSON.stringify({ ...stale, status: 'failed' }));
		const get = bucket.get.bind(bucket);
		let deleted = false;
		vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
			const record = await get(key, options);
			if (key === staleKey && !deleted) {
				deleted = true;
				await bucket.delete(paths.sessionIndexForUser(ACTOR));
			}
			return record;
		});
		const put = vi.spyOn(bucket, 'put');
		expect((await sessions.listActiveForUser(ACTOR)).map((session) => session.session_id)).toEqual([
			live.session_id,
		]);
		expect(deleted).toBe(true);
		expect(put).not.toHaveBeenCalled();
		expect(await index.read(ACTOR)).toBeNull();
	});

	it('preserves a republished session when terminal cleanup retries its index CAS', async () => {
		const { bucket, sessions, input, index } = fixture();
		const original = await sessions.createSession(input);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = bucket.put.bind(bucket);
		let paused = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.sessionIndexForUser(ACTOR) && !paused) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return put(key, value, options);
		});
		const cleanup = sessions.markFailed(input.project_id, original.session_id);
		await entered.promise;
		try {
			const replica = new SessionService(bucket, undefined, undefined, () => true);
			await replica.createSession({ ...input, session_id: original.session_id });
		} finally {
			release.resolve();
		}
		await cleanup;
		expect((await sessions.getSession(input.project_id, original.session_id)).status).toBe(
			'starting',
		);
		expect((await index.read(ACTOR))?.entries).toEqual([
			{ session_id: original.session_id, project_id: input.project_id },
		]);
		expect(await sessions.countActiveForUser(ACTOR)).toBe(1);
	});
});

describe('bounded session index reconciliation', () => {
	it.each([false, true])(
		'does not revalidate sessions or rewrite an unchanged %s index',
		async (mode) => {
			const { bucket, input } = fixture();
			const sessions = new SessionService(bucket, undefined, undefined, () => mode);
			const session = await sessions.createSession(input);
			const get = vi.spyOn(bucket, 'get');
			const put = vi.spyOn(bucket, 'put');
			await sessions.reconcileSessionIndexes([session]);
			expect(get.mock.calls).toEqual([[paths.sessionIndexForUser(ACTOR)]]);
			expect(put).not.toHaveBeenCalled();
		},
	);

	it('preserves the index ETag when stale snapshots yield unchanged live membership', async () => {
		const { bucket, sessions, input } = fixture();
		const live = await sessions.createSession(input);
		const retired = await sessions.createSession(input);
		await sessions.markFailed(input.project_id, retired.session_id);
		const key = paths.sessionIndexForUser(ACTOR);
		const before = await bucket.head(key);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		await sessions.reconcileSessionIndexes([{ ...live, status: 'failed' }, retired]);
		expect(get.mock.calls.map(([key]) => key)).toEqual([
			key,
			paths.session(input.project_id, live.session_id),
			paths.session(input.project_id, retired.session_id),
		]);
		expect(put).not.toHaveBeenCalled();
		expect((await bucket.head(key))?.etag).toBe(before?.etag);
	});

	it.each(['uniform', 'mixed-case'] as const)(
		'repairs at most 32 users per pass and catches up across %s IDs',
		async (casing) => {
			const { bucket, legacy, sessions, input, index } = fixture();
			const records = await Promise.all(
				Array.from({ length: 70 }, (_, i) =>
					legacy.createSession({
						...input,
						user_id: uid(
							casing === 'mixed-case' && i % 2 === 0
								? `USER-${String(Math.floor(i / 2)).padStart(3, '0')}`
								: `user-${String(casing === 'mixed-case' ? Math.floor(i / 2) : i).padStart(3, '0')}`,
						),
					}),
				),
			);
			const get = vi.spyOn(bucket, 'get');
			for (const expectedCount of [32, 64, 70]) {
				get.mockClear();
				await sessions.reconcileSessionIndexes(records);
				expect(
					get.mock.calls.filter(([key]) => key.startsWith(paths.sessionIndexPrefix)),
				).toHaveLength(32);
				expect(await index.listUsers()).toHaveLength(expectedCount);
			}
		},
	);
});
