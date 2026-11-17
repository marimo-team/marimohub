import { afterEach, expect, it, vi } from 'vitest';
import { makeSession } from '@marimo-hub/core/testing';
import type { SandboxStartupSnapshot } from '@marimo-hub/core/ports/sandbox';
import { sessionStartupStream } from './sessionStartupStream';
import type { SessionCreateResult } from './sessionStart';

const session = makeSession();
const result: SessionCreateResult = {
	session_id: session.session_id,
	notebook_id: session.notebook_id,
	project_id: session.project_id,
	status: 'running',
	started_at: session.started_at,
	last_heartbeat: session.last_heartbeat,
	mode: 'edit',
	reused: false,
	can: { attach: true, stop: true },
};
const progress = (detail: string) => ({
	phase: 'allocating' as const,
	detail,
	started_at: new Date().toISOString(),
	attempt: 1,
	observed: ['allocating' as const],
});
const safeError = () => ({ code: 'INTERNAL_ERROR', message: 'Startup failed', status: 500 });
async function pendingStart(signal?: AbortSignal) {
	const finish = Promise.withResolvers<SessionCreateResult>();
	let report!: (progress: SandboxStartupSnapshot) => void;
	const stream = sessionStartupStream(
		({ onAuthorized, onProgress }) => {
			report = onProgress;
			onAuthorized();
			return finish.promise;
		},
		safeError,
		signal,
	);
	await stream.started;
	return { stream, finish, report };
}

afterEach(() => vi.useRealTimers());

it('streams a final coalesced detail and keepalives during a five-minute start', async () => {
	vi.useFakeTimers();
	const { stream, finish, report } = await pendingStart();
	const reader = stream.response.body!.getReader();
	const read = async () => new TextDecoder().decode((await reader.read()).value);
	expect(await read()).toContain(': connected');
	report(progress('Queued'));
	expect(await read()).toContain('Queued');
	report(progress('Pulling image'));
	const detail = read();
	await vi.advanceTimersByTimeAsync(1000);
	expect(await detail).toContain('Pulling image');
	for (let elapsed = 0; elapsed < 300_000; elapsed += 15_000) {
		const heartbeat = read();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await heartbeat).toContain(': keepalive');
	}
	finish.resolve(result);
	await stream.done;
	expect(await read()).toContain('event: result');
	expect((await reader.read()).done).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it('bounds slow-client buffering and completes provisioning without waiting for a reader', async () => {
	const stream = sessionStartupStream(async ({ onAuthorized, onProgress }) => {
		onAuthorized();
		for (let i = 0; i < 10_000; i++) onProgress(progress(`update ${i}`));
		return result;
	}, safeError);
	await stream.started;
	await stream.done;
	const body = await stream.response.text();
	expect(body.match(/event: progress/g)).toHaveLength(1);
	expect(body).toContain('update 9999');
	expect(body).toContain('event: result');
});

it('disconnect stops observation but leaves the start running', async () => {
	vi.useFakeTimers();
	const { stream, finish } = await pendingStart();
	await stream.response.body!.cancel();
	expect(vi.getTimerCount()).toBe(0);
	finish.resolve(result);
	await expect(stream.done).resolves.toBeUndefined();
});

it('rejects before authorization and sends only safe errors after authorization', async () => {
	const early = sessionStartupStream(async () => {
		throw new Error('Private cluster name');
	}, safeError);
	await expect(early.started).rejects.toThrow('Private cluster name');
	await early.done;
	const late = sessionStartupStream(async ({ onAuthorized }) => {
		onAuthorized();
		throw new Error('Private cluster name');
	}, safeError);
	await late.started;
	const body = await late.response.text();
	expect(body).toContain('event: error');
	expect(body).toContain('Startup failed');
	expect(body).not.toContain('Private cluster name');
});

it('request abort ends observation without aborting the start', async () => {
	vi.useFakeTimers();
	const request = new AbortController();
	const { stream, finish } = await pendingStart(request.signal);
	const reader = stream.response.body!.getReader();
	await reader.read();
	request.abort();
	expect((await reader.read()).done).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	finish.resolve(result);
	await expect(stream.done).resolves.toBeUndefined();
});

it('expires observation without fabricating a provisioning failure', async () => {
	vi.useFakeTimers();
	const { stream, finish } = await pendingStart();
	await vi.advanceTimersByTimeAsync(30 * 60_000);
	const body = await stream.response.text();
	expect(body).toContain('STREAM_EXPIRED');
	expect(body).not.toContain('event: result');
	expect(vi.getTimerCount()).toBe(0);
	finish.resolve(result);
	await stream.done;
});

it('drops queued progress on failure and closes with exactly one error for a slow reader', async () => {
	vi.useFakeTimers();
	const stream = sessionStartupStream(async ({ onAuthorized, onProgress }) => {
		onAuthorized();
		for (let i = 0; i < 1000; i++) onProgress(progress(`queued ${i}`));
		throw new Error('Private provider failure');
	}, safeError);
	await stream.started;
	await stream.done;
	const body = await stream.response.text();
	expect(body.match(/event: error/g)).toHaveLength(1);
	expect(body).not.toContain('event: progress');
	expect(body).not.toContain('Private provider failure');
	expect(vi.getTimerCount()).toBe(0);
});

it.each(['result', 'error'] as const)(
	'keeps a queued expiry when provisioning later finishes with %s',
	async (outcome) => {
		vi.useFakeTimers();
		const { stream, finish } = await pendingStart();
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		if (outcome === 'result') finish.resolve(result);
		else finish.reject(new Error('Late failure'));
		await stream.done;
		const body = await stream.response.text();
		expect(body).toContain('STREAM_EXPIRED');
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).not.toContain('event: result');
		expect(vi.getTimerCount()).toBe(0);
	},
);

it.each(['before-authorization', 'after-authorization'] as const)(
	'settles a failure after cancellation %s',
	async (when) => {
		vi.useFakeTimers();
		const request = new AbortController();
		const finish = Promise.withResolvers<SessionCreateResult>();
		let authorize!: () => void;
		const stream = sessionStartupStream(
			({ onAuthorized }) => {
				authorize = onAuthorized;
				return finish.promise;
			},
			safeError,
			request.signal,
		);
		await Promise.resolve();
		if (when === 'before-authorization') request.abort();
		authorize();
		await stream.started;
		await stream.response.body!.cancel();
		request.abort();
		finish.reject(new Error('Failure after disconnect'));
		await expect(stream.done).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	},
);

it('sends phase transitions and replacement attempts without waiting for the detail throttle', async () => {
	vi.useFakeTimers();
	const { stream, finish, report } = await pendingStart();
	const reader = stream.response.body!.getReader();
	await reader.read();
	for (const update of [
		progress('First'),
		{ ...progress('Workspace'), phase: 'workspace' as const },
		{ ...progress('Replacement'), attempt: 2 },
	]) {
		report(update);
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(update.detail);
	}
	await reader.cancel();
	finish.resolve(result);
	await stream.done;
	expect(vi.getTimerCount()).toBe(0);
});
