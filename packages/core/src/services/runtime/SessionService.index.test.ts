import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR, uid } from '../../testing';
import { createNotebookId, createProjectId, createSessionId, SandboxId } from '../../ids';
import { paths } from '../../paths';
import { PreconditionFailedError } from '../../errors';
import { SessionIndexSchema } from '../../schema';
import { SessionService } from './SessionService';
import { SessionIndex } from './SessionIndex';
import { legacySessions } from '../../testing/legacy-sessions';

afterEach(() => vi.restoreAllMocks());

function fixture() {
	const bucket = new MemoryBucket();
	const metrics = { increment: vi.fn(), gauge: vi.fn() };
	const sessions = new SessionService(bucket, metrics, undefined, () => true);
	const input = { project_id: createProjectId(), notebook_id: createNotebookId(), user_id: ACTOR };
	return { bucket, metrics, sessions, input, index: new SessionIndex(bucket) };
}

function failIndexWrites(bucket: MemoryBucket, error = new Error('index unavailable')) {
	const put = bucket.put.bind(bucket);
	return vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
		if (key === paths.sessionIndexForUser(ACTOR)) throw error;
		return put(key, value, options);
	});
}

function pauseNextIndexWrite(bucket: MemoryBucket) {
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
	return { entered: entered.promise, release: () => release.resolve() };
}

describe('per-user session index', () => {
	it('reads only this user on a cold replica, with no LISTs', async () => {
		const { bucket, sessions, input } = fixture();
		const own = await sessions.createSession(input);
		for (let i = 0; i < 25; i++)
			await sessions.createSession({ ...input, user_id: uid(`other-${i}`) });
		const cold = new SessionService(bucket, undefined, undefined, () => true);
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');
		expect((await cold.listActiveForUser(ACTOR)).map((s) => s.session_id)).toEqual([
			own.session_id,
		]);
		expect(list).not.toHaveBeenCalled();
		expect(get.mock.calls.map(([key]) => key)).toEqual([
			paths.sessionIndexForUser(ACTOR),
			paths.session(input.project_id, own.session_id),
		]);
		get.mockClear();
		await cold.listActiveForUser(ACTOR);
		expect(get.mock.calls[1]?.[1]).toMatchObject({ ifNoneMatch: expect.any(String) });
	});

	it('concurrent replicas register both starts and derive the same queue as the scan', async () => {
		const { bucket, sessions, input, index } = fixture();
		const other = new SessionService(bucket, undefined, undefined, () => true);
		const created = await Promise.all([sessions.createSession(input), other.createSession(input)]);
		expect((await index.read(ACTOR))!.entries).toHaveLength(2);
		const scanned = await new SessionService(bucket, undefined, undefined).listActiveForUser(ACTOR);
		expect(await sessions.listActiveForUser(ACTOR)).toEqual(scanned);
		expect(await other.listActiveForUser(ACTOR)).toEqual(scanned);
		await other.setRunning(input.project_id, created[1].session_id, 'https://kernel.example');
		expect((await sessions.listActiveForUser(ACTOR))[0]?.session_id).toBe(created[1].session_id);
	});

	it('validates and removes missing and terminal entries, retaining unreclaimed apps', async () => {
		const { bucket, sessions, input, index } = fixture();
		const missing = await sessions.createSession(input);
		const terminal = await sessions.createSession(input);
		const app = await sessions.createSession({
			...input,
			mode: 'app',
			sandbox_id: SandboxId.parse('sb-0000000000000001'),
		});
		await bucket.delete(paths.session(input.project_id, missing.session_id));
		await bucket.put(
			paths.session(input.project_id, terminal.session_id),
			JSON.stringify({ ...terminal, status: 'failed' }),
		);
		await sessions.markFailed(input.project_id, app.session_id);
		expect(await sessions.listActiveForUser(ACTOR)).toEqual([]);
		expect((await sessions.listActiveForUser(ACTOR, 'project')).map((s) => s.session_id)).toEqual([
			app.session_id,
		]);
		expect((await index.read(ACTOR))!.entries.map((s) => s.session_id)).toEqual([app.session_id]);
		await sessions.markSandboxReclaimed(input.project_id, app.session_id, new Date().toISOString());
		expect((await index.read(ACTOR))!.entries).toEqual([]);
	});

	it('fails closed on index or candidate corruption and read errors', async () => {
		const { bucket, sessions, input } = fixture();
		const session = await sessions.createSession(input);
		await sessions.listActiveForUser(ACTOR);
		await bucket.put(paths.session(input.project_id, session.session_id), 'not json');
		await expect(sessions.listActiveForUser(ACTOR)).rejects.toThrow();
		await bucket.put(paths.sessionIndexForUser(ACTOR), '{}');
		await expect(sessions.listActiveForUser(ACTOR)).rejects.toThrow();
		vi.spyOn(bucket, 'get').mockRejectedValue(new Error('unavailable'));
		await expect(sessions.listActiveForUser(ACTOR)).rejects.toThrow('unavailable');
	});

	it('requires registration before returning a new session when enabled', async () => {
		const { bucket, sessions, input, metrics } = fixture();
		await sessions.listActiveForUser(ACTOR);
		failIndexWrites(bucket);
		const session_id = createSessionId();
		await expect(sessions.createSession({ ...input, session_id })).rejects.toThrow(
			'index unavailable',
		);
		expect((await sessions.getSession(input.project_id, session_id)).status).toBe('failed');
		expect(metrics.increment).toHaveBeenCalledWith('sessions.index.write_failed');
	});

	it('requires registration even before migration completes', async () => {
		const { bucket, input, metrics } = fixture();
		const sessions = new SessionService(bucket, metrics);
		failIndexWrites(bucket);
		const session_id = createSessionId();
		await expect(sessions.createSession({ ...input, session_id })).rejects.toThrow(
			'index unavailable',
		);
		expect((await sessions.getSession(input.project_id, session_id)).status).toBe('failed');
		expect(metrics.increment).toHaveBeenCalledWith('sessions.index.write_failed');
	});

	it('rejects an orphan index stored under another user key during backfill', async () => {
		const { bucket, sessions, index } = fixture();
		const wrongUser = uid('wrong-owner');
		await bucket.put(
			paths.sessionIndexForUser(ACTOR),
			JSON.stringify({ user_id: wrongUser, entries: [] }),
		);
		const put = vi.spyOn(bucket, 'put');
		await expect(sessions.rebuildSessionIndex()).rejects.toThrow('Session index owner mismatch');
		expect(put).not.toHaveBeenCalled();
		expect(await index.read(wrongUser)).toBeNull();
	});

	it('backfills legacy records and clears indexes whose last record was deleted', async () => {
		const { bucket, sessions, input, index } = fixture();
		const legacy = await legacySessions(bucket).createSession(input);
		const gone = await sessions.createSession({ ...input, user_id: uid('gone') });
		await bucket.delete(paths.session(input.project_id, gone.session_id));
		await sessions.rebuildSessionIndex();
		expect((await index.read(ACTOR))!.entries).toEqual([
			{ session_id: legacy.session_id, project_id: input.project_id },
		]);
		expect((await index.read(gone.user_id))!.entries).toEqual([]);
	});

	it('does not drop a registration racing reconciliation', async () => {
		const { bucket, sessions, input, index } = fixture();
		const first = await sessions.createSession(input);
		await index.update(ACTOR, async () => []);
		const gate = pauseNextIndexWrite(bucket);
		const sweep = sessions.reconcileSessionIndexes([first]);
		await gate.entered;
		let second;
		try {
			second = await sessions.createSession(input);
		} finally {
			gate.release();
		}
		await sweep;
		expect((await index.read(ACTOR))!.entries.map((s) => s.session_id).sort()).toEqual(
			[first.session_id, second.session_id].sort(),
		);
	});

	it('keeps lifecycle repair best-effort but reports a failed backfill', async () => {
		const { bucket, sessions, input, metrics, index } = fixture();
		const record = await sessions.createSession(input);
		await index.update(ACTOR, async () => []);
		await sessions.listActiveForUser(ACTOR);
		failIndexWrites(bucket);
		await expect(sessions.reconcileSessionIndexes([record])).resolves.toBeUndefined();
		expect(metrics.increment).toHaveBeenCalledWith('sessions.index.write_failed');
		await expect(sessions.rebuildSessionIndex()).rejects.toThrow('index unavailable');
	});

	it('does not resurrect a terminal record from an old sweep snapshot', async () => {
		const { sessions, input, index } = fixture();
		const first = await sessions.createSession(input);
		await sessions.terminate(input.project_id, first.session_id);
		await sessions.reconcileSessionIndexes([first]);
		expect((await index.read(ACTOR))!.entries).toEqual([]);
	});

	it('rejects duplicate references and encodes opaque user IDs', () => {
		const entry = { project_id: createProjectId(), session_id: createSessionId() };
		expect(SessionIndexSchema.safeParse({ user_id: ACTOR, entries: [entry, entry] }).success).toBe(
			false,
		);
		expect(paths.sessionIndexForUser(uid('oidc/a%b'))).toBe(
			'_system/session-index/users/oidc%2Fa%25b.json',
		);
	});

	it.each(['owner', 'user_id', 'project_id', 'session_id'] as const)(
		'rejects a mismatched %s without rewriting the index',
		async (field) => {
			const { bucket, sessions, input, index } = fixture();
			const session = await sessions.createSession(input);
			await sessions.listActiveForUser(ACTOR);
			if (field === 'owner') {
				await bucket.put(
					paths.sessionIndexForUser(ACTOR),
					JSON.stringify({ ...(await index.read(ACTOR)), user_id: uid('wrong-owner') }),
				);
			} else {
				const wrong = {
					user_id: uid('wrong-user'),
					project_id: createProjectId(),
					session_id: createSessionId(),
				};
				await bucket.put(
					paths.session(input.project_id, session.session_id),
					JSON.stringify({ ...session, [field]: wrong[field] }),
				);
			}
			const put = vi.spyOn(bucket, 'put');
			await expect(sessions.listActiveForUser(ACTOR)).rejects.toThrow(/mismatch/);
			expect(put).not.toHaveBeenCalled();
		},
	);

	it('does not serve a cached candidate when conditional validation fails', async () => {
		const { bucket, sessions, input } = fixture();
		const session = await sessions.createSession(input);
		await sessions.listActiveForUser(ACTOR);
		const get = bucket.get.bind(bucket);
		const failure = vi.spyOn(bucket, 'get').mockImplementation((key, options) => {
			if (key === paths.session(input.project_id, session.session_id)) {
				expect(options).toMatchObject({ ifNoneMatch: expect.any(String) });
				throw new Error('validation unavailable');
			}
			return get(key, options);
		});
		await expect(sessions.listActiveForUser(ACTOR)).rejects.toThrow('validation unavailable');
		failure.mockRestore();
		expect((await sessions.listActiveForUser(ACTOR)).map((s) => s.session_id)).toEqual([
			session.session_id,
		]);
	});

	it('does not fail termination or count stale entries when index cleanup is unavailable', async () => {
		const { bucket, sessions, input, index, metrics } = fixture();
		const retired = await sessions.createSession(input);
		const live = await sessions.createSession(input);
		const failure = failIndexWrites(bucket, new Error('cleanup unavailable'));
		expect((await sessions.terminate(input.project_id, retired.session_id)).status).toBe(
			'terminated',
		);
		expect((await sessions.listActiveForUser(ACTOR)).map((s) => s.session_id)).toEqual([
			live.session_id,
		]);
		expect((await index.read(ACTOR))!.entries).toHaveLength(2);
		expect(metrics.increment).toHaveBeenCalledWith('sessions.index.write_failed');
		failure.mockRestore();
		await sessions.listActiveForUser(ACTOR);
		expect((await index.read(ACTOR))!.entries.map((entry) => entry.session_id)).toEqual([
			live.session_id,
		]);
	});

	it('rejects registration after CAS exhaustion without dropping an incumbent', async () => {
		const { bucket, sessions, input, index } = fixture();
		const incumbent = await sessions.createSession(input);
		const conflict = failIndexWrites(bucket, new PreconditionFailedError('contended'));
		const session_id = createSessionId();
		await expect(sessions.createSession({ ...input, session_id })).rejects.toThrow(
			'max retries exceeded',
		);
		expect(
			conflict.mock.calls.filter(([key]) => key === paths.sessionIndexForUser(ACTOR)).length,
		).toBeGreaterThan(1);
		expect((await sessions.getSession(input.project_id, session_id)).status).toBe('failed');
		expect((await index.read(ACTOR))!.entries.map((entry) => entry.session_id)).toEqual([
			incumbent.session_id,
		]);
	});

	it('rejects an uncertain registration and later removes its failed record reference', async () => {
		const { bucket, sessions, input, index } = fixture();
		await sessions.listActiveForUser(ACTOR);
		const put = bucket.put.bind(bucket);
		const failure = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			const written = await put(key, value, options);
			if (key === paths.sessionIndexForUser(ACTOR)) throw new Error('acknowledgment lost');
			return written;
		});
		const session_id = createSessionId();
		await expect(sessions.createSession({ ...input, session_id })).rejects.toThrow(
			'acknowledgment lost',
		);
		expect((await sessions.getSession(input.project_id, session_id)).status).toBe('failed');
		expect((await index.read(ACTOR))!.entries).toHaveLength(1);
		failure.mockRestore();
		expect(await sessions.listActiveForUser(ACTOR)).toEqual([]);
		expect((await index.read(ACTOR))!.entries).toEqual([]);
	});

	it('preserves the registration error when marking the rejected session also fails', async () => {
		const { bucket, sessions, input } = fixture();
		const put = bucket.put.bind(bucket);
		await sessions.listActiveForUser(ACTOR);
		const session_id = createSessionId();
		const registrationError = new Error('registration failed');
		const failure = vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (key === paths.sessionIndexForUser(ACTOR)) throw registrationError;
			if (key === paths.session(input.project_id, session_id) && options?.onlyIfEtagMatches)
				throw new Error('failure marking failed');
			return put(key, value, options);
		});
		await expect(sessions.createSession({ ...input, session_id })).rejects.toBe(registrationError);
		failure.mockRestore();
		await sessions.rebuildSessionIndex();
		expect((await sessions.listActiveForUser(ACTOR)).map((s) => s.session_id)).toEqual([
			session_id,
		]);
	});

	it('repairs other users when one user index cannot be written', async () => {
		const { bucket, sessions, input, index } = fixture();
		const legacy = legacySessions(bucket);
		const first = await legacy.createSession(input);
		const second = await legacy.createSession({ ...input, user_id: uid('other') });
		failIndexWrites(bucket, new Error('one corrupt index'));
		await sessions.reconcileSessionIndexes([first, second]);
		expect((await index.read(second.user_id))!.entries.map((entry) => entry.session_id)).toEqual([
			second.session_id,
		]);
	});

	it('backfills across LIST pages with one index write per user', async () => {
		const { bucket, sessions, input, index } = fixture();
		const legacy = legacySessions(bucket);
		const records = await Promise.all([
			legacy.createSession(input),
			legacy.createSession(input),
			legacy.createSession({ ...input, user_id: uid('other') }),
		]);
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementation((options) => list({ ...options, limit: 1 }));
		const put = vi.spyOn(bucket, 'put');
		await sessions.rebuildSessionIndex();
		for (const user of [ACTOR, uid('other')]) {
			expect((await index.read(user))!.entries.map((entry) => entry.session_id).sort()).toEqual(
				records
					.filter((s) => s.user_id === user)
					.map((s) => s.session_id)
					.sort(),
			);
			expect(
				put.mock.calls.filter(([key]) => key === paths.sessionIndexForUser(user)),
			).toHaveLength(1);
		}
	});

	it.each(['republish', 'terminate'] as const)(
		'revalidates after %s wins a race with stale cleanup',
		async (race) => {
			const { bucket, sessions, input, index } = fixture();
			const record = await sessions.createSession(input);
			if (race === 'terminate') await index.update(ACTOR, async () => []);
			if (race === 'republish')
				await bucket.delete(paths.session(input.project_id, record.session_id));
			const gate = pauseNextIndexWrite(bucket);
			const sweep = sessions.reconcileSessionIndexes(
				[{ ...record, status: race === 'republish' ? 'terminated' : record.status }],
				{ failOnError: true },
			);
			await gate.entered;
			try {
				if (race === 'republish')
					await sessions.createSession({ ...input, session_id: record.session_id });
				else await sessions.terminate(input.project_id, record.session_id);
			} finally {
				gate.release();
			}
			await sweep;
			expect((await index.read(ACTOR))!.entries.map((entry) => entry.session_id)).toEqual(
				race === 'republish' ? [record.session_id] : [],
			);
		},
	);

	it('does not re-read or write a no-op heartbeat supplied by the request', async () => {
		const { sessions, input, bucket } = fixture();
		const session = await sessions.createSession(input);
		await sessions.setRunning(input.project_id, session.session_id, 'https://kernel.example');
		const known = await sessions.getSessionWithEtag(input.project_id, session.session_id);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		expect(await sessions.heartbeat(input.project_id, session.session_id, known)).toBe(known.value);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});
});
