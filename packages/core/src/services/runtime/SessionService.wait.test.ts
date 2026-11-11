import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from './SessionService';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { ACTOR, makeSession } from '../../testing';
import { paths } from '../../paths';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const bucket = new MemoryBucket();
	const session = makeSession({ status: 'starting', user_id: ACTOR });
	await bucket.put(paths.session(session.project_id, session.session_id), JSON.stringify(session));
	return { bucket, session, service: new SessionService(bucket) };
}

describe('session startup waiting', () => {
	it('wakes concurrent waiters immediately after local publication', async () => {
		vi.useFakeTimers();
		const { bucket, session, service } = await fixture();
		const get = vi.spyOn(bucket, 'get');
		const waits = Array.from({ length: 20 }, () => service.waitForStartup(session, 20_000));
		await vi.advanceTimersByTimeAsync(0);
		expect(get).toHaveBeenCalledTimes(1);
		await service.setRunning(session.project_id, session.session_id, 'https://sandbox.test');
		expect((await Promise.all(waits)).every((value) => value.status === 'running')).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('wakes local waiters immediately after a startup failure', async () => {
		vi.useFakeTimers();
		const { session, service } = await fixture();
		const waiting = service.waitForStartup(session, 20_000);
		await vi.advanceTimersByTimeAsync(0);
		await service.markFailed(session.project_id, session.session_id, {
			code: 'BOOT_FAILED',
			message: 'Sandbox did not start',
		});
		expect((await waiting).status).toBe('failed');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('observes a different replica and returns terminal startup failures', async () => {
		vi.useFakeTimers();
		const { bucket, session, service } = await fixture();
		const waiting = service.waitForStartup(session, 20_000);
		await vi.advanceTimersByTimeAsync(0);
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify({ ...session, status: 'failed' }),
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await waiting).status).toBe('failed');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('returns a still-starting session at the bounded deadline', async () => {
		vi.useFakeTimers();
		const { session, service } = await fixture();
		const waiting = service.waitForStartup(session, 100_000);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(await waiting).toEqual(session);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['timeout', 'publication', 'disconnect'] as const)(
		'finishes on %s even when a shared storage read is stalled',
		async (outcome) => {
			vi.useFakeTimers();
			const { session, service } = await fixture();
			const read = Promise.withResolvers<typeof session>();
			vi.spyOn(service, 'getSession').mockReturnValueOnce(read.promise);
			const controller = new AbortController();
			const waiting = service.waitForStartup(session, 20_000, controller.signal);
			if (outcome === 'disconnect') {
				const rejected = expect(waiting).rejects.toThrow('disconnected');
				controller.abort(new Error('disconnected'));
				await rejected;
			} else {
				if (outcome === 'publication')
					await service.setRunning(session.project_id, session.session_id, 'https://sandbox.test');
				else await vi.advanceTimersByTimeAsync(20_000);
				expect((await waiting).status).toBe(outcome === 'publication' ? 'running' : 'starting');
			}
			expect(vi.getTimerCount()).toBe(0);
			await service.setRunning(session.project_id, session.session_id, 'https://sandbox.test');
			expect((await service.waitForStartup(session, 20_000)).status).toBe('running');
			read.reject(new Error('late storage failure'));
			await vi.advanceTimersByTimeAsync(0);
		},
	);

	it('cancels a disconnected wait without leaking timers or breaking later waits', async () => {
		vi.useFakeTimers();
		const { session, service } = await fixture();
		const controller = new AbortController();
		const waiting = service.waitForStartup(session, 20_000, controller.signal);
		const rejected = expect(waiting).rejects.toThrow('disconnected');
		await vi.advanceTimersByTimeAsync(0);
		controller.abort(new Error('disconnected'));
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
		await service.setRunning(session.project_id, session.session_id, 'https://sandbox.test');
		expect((await service.waitForStartup(session, 20_000)).status).toBe('running');
	});

	it('propagates storage failures and can retry afterwards', async () => {
		const { bucket, session, service } = await fixture();
		vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('unavailable'));
		await expect(service.waitForStartup(session, 20_000)).rejects.toThrow('unavailable');
		await service.setRunning(session.project_id, session.session_id, 'https://sandbox.test');
		expect((await service.waitForStartup(session, 20_000)).status).toBe('running');
	});
});

describe('unused warm sandbox ownership', () => {
	it('cannot relinquish a sandbox after a stop wins the session CAS', async () => {
		const { bucket, session, service } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = bucket.put.bind(bucket);
		let paused = false;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, body, options) => {
			if (
				!paused &&
				key === paths.session(session.project_id, session.session_id) &&
				String(body).includes('sandbox_reclaimed_at')
			) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return put(key, body, options);
		});
		const relinquish = service.relinquishStartingSandbox(
			session.project_id,
			session.session_id,
			session.sandbox_id!,
		);
		await entered.promise;
		await service.beginTerminating(session.project_id, session.session_id);
		release.resolve();
		expect(await relinquish).toBe(false);
		const stopped = await service.getSession(session.project_id, session.session_id);
		expect(stopped.status).toBe('terminating');
		expect(stopped.sandbox_reclaimed_at).toBeUndefined();
	});

	it('marks ownership reclaimed before a later stop can claim teardown', async () => {
		const { session, service } = await fixture();
		expect(
			await service.relinquishStartingSandbox(
				session.project_id,
				session.session_id,
				session.sandbox_id!,
			),
		).toBe(true);
		const stopped = await service.beginTerminating(session.project_id, session.session_id);
		expect(stopped.session.sandbox_reclaimed_at).toEqual(expect.any(String));
	});
});
