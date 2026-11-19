import { afterEach, expect, it, vi } from 'vitest';
import { SessionService } from './SessionService';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { makeSession } from '../../testing';
import { createSandboxId } from '../../ids';
import { paths } from '../../paths';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const bucket = new MemoryBucket();
	const session = makeSession({ status: 'starting', sandbox_id: createSandboxId() });
	await bucket.put(paths.session(session.project_id, session.session_id), JSON.stringify(session));
	const writer = new SessionService(bucket);
	const reader = new SessionService(bucket);
	const progress = {
		sandbox_id: session.sandbox_id!,
		phase: 'allocating' as const,
		attempt: 1,
		started_at: new Date().toISOString(),
		observed: ['allocating' as const],
	};
	return { bucket, session, writer, reader, progress };
}

it('recovers phase and terminal error on another replica and after reconnect', async () => {
	vi.useFakeTimers();
	const { session: s, writer, reader, progress } = await fixture();
	const stream = reader.watchStartupStatus(s.project_id, s.session_id);
	expect((await stream.next()).value).toMatchObject({ status: 'starting', startup: null });
	await writer.recordStartupProgress(s.project_id, s.session_id, progress);
	const next = stream.next();
	await vi.advanceTimersByTimeAsync(1000);
	expect((await next).value).toMatchObject({ startup: progress });
	const error = { code: 'BOOT_FAILED', message: 'The runtime could not start' };
	await writer.markFailed(s.project_id, s.session_id, error);
	const failedAt = new Date().toISOString();
	vi.advanceTimersByTime(5000);
	const terminal = stream.next();
	await vi.advanceTimersByTimeAsync(1000);
	expect((await terminal).value).toMatchObject({
		status: 'failed',
		status_changed_at: failedAt,
		error,
		startup: progress,
	});
	expect((await stream.next()).done).toBe(true);
	const reconnect = reader.watchStartupStatus(s.project_id, s.session_id);
	expect((await reconnect.next()).value).toEqual(
		await reader.getStartupStatus(s.project_id, s.session_id),
	);
	expect((await reconnect.next()).done).toBe(true);
});

it('ignores duplicates, regressing phases, replaced sandboxes and progress after stop', async () => {
	const { session: s, writer, reader, progress } = await fixture();
	const write = (p: Parameters<SessionService['recordStartupProgress']>[2]) =>
		writer.recordStartupProgress(s.project_id, s.session_id, p);
	await write({ ...progress, phase: 'workspace', observed: ['allocating', 'workspace'] });
	const current = await reader.getStartupStatus(s.project_id, s.session_id);
	await write(progress);
	await write({ ...progress, sandbox_id: createSandboxId(), attempt: 2 });
	expect(await reader.getStartupStatus(s.project_id, s.session_id)).toEqual(current);
	await writer.beginTerminating(s.project_id, s.session_id);
	await write({ ...progress, phase: 'starting' });
	expect((await reader.getStartupStatus(s.project_id, s.session_id)).startup).toEqual(
		current.startup,
	);
	await writer.markFailed(s.project_id, s.session_id, { code: 'LATE', message: 'Late failure' });
	expect((await reader.getStartupStatus(s.project_id, s.session_id)).status).toBe('terminating');
});

it('coalesces changes for a slow consumer without an event queue', async () => {
	vi.useFakeTimers();
	const { session: s, writer, reader, progress } = await fixture();
	const stream = reader.watchStartupStatus(s.project_id, s.session_id);
	await stream.next();
	await writer.recordStartupProgress(s.project_id, s.session_id, progress);
	await writer.setRunning(s.project_id, s.session_id, 'https://runtime.test');
	const next = stream.next();
	await vi.advanceTimersByTimeAsync(1000);
	expect((await next).value).toMatchObject({ status: 'running' });
	expect((await stream.next()).done).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it('disconnect cancels polling without changing the stored session', async () => {
	const { session: s, reader } = await fixture();
	const abort = new AbortController();
	const stream = reader.watchStartupStatus(s.project_id, s.session_id, abort.signal);
	await stream.next();
	const next = stream.next();
	abort.abort(new Error('Disconnected'));
	await expect(next).rejects.toThrow('Disconnected');
	expect((await reader.getStartupStatus(s.project_id, s.session_id)).status).toBe('starting');
});

it('finds a transition committed between the initial read and its delivery', async () => {
	vi.useFakeTimers();
	const { session: s, writer, reader } = await fixture();
	const stale = await reader.getStartupStatus(s.project_id, s.session_id);
	const gate = Promise.withResolvers<typeof stale>();
	vi.spyOn(reader, 'getStartupStatus').mockReturnValueOnce(gate.promise);
	const stream = reader.watchStartupStatus(s.project_id, s.session_id);
	const initial = stream.next();
	await writer.markFailed(s.project_id, s.session_id, { code: 'BOOT_FAILED', message: 'Failed' });
	gate.resolve(stale);
	expect((await initial).value).toMatchObject({ status: 'starting' });
	const next = stream.next();
	await vi.advanceTimersByTimeAsync(1000);
	expect((await next).value).toMatchObject({ status: 'failed' });
	expect((await stream.next()).done).toBe(true);
});

it.each([false, true])(
	'publishes pending progress without overriding a stop (stopped: %s)',
	async (stopped) => {
		const { session: s, writer, reader, progress } = await fixture();
		if (stopped) await writer.beginTerminating(s.project_id, s.session_id);
		await writer.setRunning(
			s.project_id,
			s.session_id,
			'https://runtime.test',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ ...progress, phase: 'starting' },
		);
		expect(await reader.getStartupStatus(s.project_id, s.session_id)).toMatchObject(
			stopped
				? { status: 'terminating', startup: null }
				: { status: 'running', startup: { phase: 'starting' } },
		);
	},
);

it('cannot overwrite an existing session by recreating its ID', async () => {
	const { session, writer, reader } = await fixture();
	await writer.markFailed(session.project_id, session.session_id);
	const before = await reader.getSession(session.project_id, session.session_id);
	await expect(
		writer.createSession({
			session_id: session.session_id,
			project_id: session.project_id,
			notebook_id: session.notebook_id,
			user_id: session.user_id,
			sandbox_id: createSandboxId(),
		}),
	).rejects.toThrow();
	expect(await reader.getSession(session.project_id, session.session_id)).toEqual(before);
});

it.each(['stop', 'running', 'failed', 'replacement', 'newer phase'] as const)(
	'does not overwrite a concurrent %s after losing the progress CAS',
	async (winner) => {
		const { bucket, session: s, writer, reader, progress } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return put(...args);
		});
		const staleWrite = writer.recordStartupProgress(s.project_id, s.session_id, {
			...progress,
			phase: 'workspace',
		});
		await entered.promise;
		try {
			if (winner === 'stop') await reader.beginTerminating(s.project_id, s.session_id);
			else if (winner === 'replacement')
				await reader.replaceStartingSandbox(
					s.project_id,
					s.session_id,
					s.sandbox_id!,
					createSandboxId(),
				);
			else if (winner === 'running')
				await reader.setRunning(
					s.project_id,
					s.session_id,
					'https://runtime.test',
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{ ...progress, phase: 'starting' },
				);
			else if (winner === 'failed')
				await reader.markFailedWithOutcome(
					s.project_id,
					s.session_id,
					{ code: 'BOOT_FAILED', message: 'Failed' },
					{ ...progress, phase: 'starting' },
				);
			else
				await reader.recordStartupProgress(s.project_id, s.session_id, {
					...progress,
					phase: 'starting',
				});
		} finally {
			release.resolve();
		}
		await staleWrite;
		expect(await reader.getStartupStatus(s.project_id, s.session_id)).toMatchObject(
			winner === 'stop'
				? { status: 'terminating', startup: null }
				: winner === 'replacement'
					? { status: 'starting', startup: null }
					: {
							status: winner === 'newer phase' ? 'starting' : winner,
							startup: { phase: 'starting' },
						},
		);
	},
);

it('accepts a replacement attempt and ignores delayed callbacks from its predecessor', async () => {
	const { session: s, writer, reader, progress } = await fixture();
	await writer.recordStartupProgress(s.project_id, s.session_id, {
		...progress,
		phase: 'starting',
	});
	const replacement = createSandboxId();
	await writer.replaceStartingSandbox(s.project_id, s.session_id, s.sandbox_id!, replacement);
	await writer.recordStartupProgress(s.project_id, s.session_id, { ...progress, attempt: 2 });
	expect((await reader.getStartupStatus(s.project_id, s.session_id)).startup).toBeNull();
	const next = { ...progress, sandbox_id: replacement, attempt: 2 };
	await writer.recordStartupProgress(s.project_id, s.session_id, next);
	await writer.recordStartupProgress(s.project_id, s.session_id, {
		...progress,
		phase: 'starting',
	});
	expect((await reader.getStartupStatus(s.project_id, s.session_id)).startup).toEqual(next);
});

it.each(['missing', 'corrupt', 'unavailable'] as const)(
	'rejects a subscription when storage becomes %s and recovers on reconnect',
	async (failure) => {
		vi.useFakeTimers();
		const { bucket, session: s, reader, writer } = await fixture();
		const key = paths.session(s.project_id, s.session_id);
		const stream = reader.watchStartupStatus(s.project_id, s.session_id);
		await stream.next();
		if (failure === 'missing') await bucket.delete(key);
		else if (failure === 'corrupt') await bucket.put(key, '{');
		else vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('Storage unavailable'));
		const rejected = expect(stream.next()).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect((await stream.next()).done).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		await bucket.put(key, JSON.stringify(s));
		await writer.markFailed(s.project_id, s.session_id, { code: 'BOOT_FAILED', message: 'Failed' });
		const reconnect = reader.watchStartupStatus(s.project_id, s.session_id);
		expect((await reconnect.next()).value).toMatchObject({
			status: 'failed',
			error: { code: 'BOOT_FAILED' },
		});
		expect((await reconnect.next()).done).toBe(true);
	},
);

it('cancels a stalled storage read and consumes a late storage rejection', async () => {
	const { bucket, session: s, reader } = await fixture();
	const read = Promise.withResolvers<Awaited<ReturnType<typeof bucket.get>>>();
	vi.spyOn(bucket, 'get').mockReturnValueOnce(read.promise);
	const abort = new AbortController();
	const stream = reader.watchStartupStatus(s.project_id, s.session_id, abort.signal);
	const rejected = expect(stream.next()).rejects.toThrow('Disconnected');
	abort.abort(new Error('Disconnected'));
	await rejected;
	read.reject(new Error('Late storage failure'));
	expect((await stream.next()).done).toBe(true);
});

it('compares phase timestamps as instants rather than strings', async () => {
	const { session: s, writer, reader, progress } = await fixture();
	await writer.recordStartupProgress(s.project_id, s.session_id, {
		...progress,
		started_at: '2026-11-18T00:00:00Z',
	});
	await writer.recordStartupProgress(s.project_id, s.session_id, {
		...progress,
		phase: 'workspace',
		started_at: '2026-11-18T00:00:00.100Z',
	});
	await writer.recordStartupProgress(s.project_id, s.session_id, {
		...progress,
		phase: 'starting',
		started_at: '2026-11-18T00:00:00.050Z',
	});
	expect((await reader.getStartupStatus(s.project_id, s.session_id)).startup).toMatchObject({
		phase: 'workspace',
		started_at: '2026-11-18T00:00:00.100Z',
	});
});
