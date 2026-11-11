import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from './SessionService';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { ACTOR, makeSession } from '../../testing';
import { createSandboxId } from '../../ids';
import { paths } from '../../paths';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const bucket = new MemoryBucket();
	const session = makeSession({
		status: 'starting',
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
		last_heartbeat: new Date().toISOString(),
	});
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

describe('heartbeat snapshot isolation', () => {
	it.each(['known', 'unavailable'] as const)(
		'isolates older running and newer terminating snapshots with %s ETags',
		async (etag) => {
			const { session, service } = await fixture();
			await service.setRunning(session.project_id, session.session_id, 'https://kernel.test');
			const running = await service.getSessionWithEtag(session.project_id, session.session_id);
			await service.beginTerminating(session.project_id, session.session_id);
			const stopping = await service.getSessionWithEtag(session.project_id, session.session_id);
			if (etag === 'unavailable') running.etag = stopping.etag = '';
			const [older, newer] = await Promise.all([
				service.heartbeat(session.project_id, session.session_id, running),
				service.heartbeat(session.project_id, session.session_id, stopping),
			]);
			expect(older.status).toBe('running');
			expect(newer.status).toBe('terminating');
		},
	);

	it('still shares a due write for concurrent callers with the same ETag', async () => {
		const { bucket, session, service } = await fixture();
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify({
				...session,
				status: 'running',
				last_heartbeat: new Date(Date.now() - 61_000).toISOString(),
			}),
		);
		const known = await service.getSessionWithEtag(session.project_id, session.session_id);
		const get = vi.spyOn(bucket, 'get');
		const put = vi.spyOn(bucket, 'put');
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				service.heartbeat(session.project_id, session.session_id, known),
			),
		);
		expect(
			results.every(
				(result) => Date.parse(result.last_heartbeat) > Date.parse(known.value.last_heartbeat),
			),
		).toBe(true);
		expect(put).toHaveBeenCalledOnce();
		expect(get).not.toHaveBeenCalled();
	});

	it('reads independently when callers do not supply an ETag', async () => {
		const { bucket, session, service } = await fixture();
		await service.setRunning(session.project_id, session.session_id, 'https://kernel.test');
		const get = bucket.get.bind(bucket);
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(bucket, 'get').mockImplementationOnce(async (key) => {
			const object = await get(key);
			captured.resolve();
			await release.promise;
			return object;
		});
		const older = service.heartbeat(session.project_id, session.session_id);
		await captured.promise;
		await service.beginTerminating(session.project_id, session.session_id);
		expect((await service.heartbeat(session.project_id, session.session_id)).status).toBe(
			'terminating',
		);
		release.resolve();
		expect((await older).status).toBe('running');
	});
});
