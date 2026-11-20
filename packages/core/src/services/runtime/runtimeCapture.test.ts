import { CaptureTelemetry } from '../../internal/captureTelemetry';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxId } from '../../ids';
import { execResult } from '../../ports/sandbox';
import type { SandboxInstance } from '../../ports/sandbox';
import { makeFakeSandbox } from '../../testing';
import { RuntimeCaptureClient, RuntimeCaptureError } from './runtimeCapture';

describe('runtime checkpoint client', () => {
	it('retains an unsupported but running editor without attempting a pause', async () => {
		const { instance } = makeFakeSandbox();
		const exec = vi
			.spyOn(instance, 'exec')
			.mockResolvedValue(
				execResult(true, JSON.stringify({ ok: true, state: 'running', supported: false }), ''),
			);
		await expect(
			new RuntimeCaptureClient(instance, createSandboxId()).prepare('/workspace', 'notebook.py'),
		).rejects.toMatchObject({ code: 'CAPTURE_RUNTIME_UNSUPPORTED', runtimeState: 'running' });
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it.each(['SOURCE_MISSING', 'ARTIFACT_TOO_LARGE', 'CAPTURE_INVALID_PATH', 'CAPTURE_READ_FAILED'])(
		'preserves actionable %s through the native reply',
		async (code) => {
			const { instance } = makeFakeSandbox();
			vi.spyOn(instance, 'exec')
				.mockResolvedValueOnce(
					execResult(true, JSON.stringify({ ok: true, state: 'running', generation: 0 }), ''),
				)
				.mockResolvedValueOnce(execResult(true, JSON.stringify({ ok: false, code }), ''))
				.mockResolvedValueOnce(
					execResult(true, JSON.stringify({ ok: true, state: 'running' }), ''),
				);
			await expect(
				new RuntimeCaptureClient(instance, createSandboxId()).prepare('/workspace', 'notebook.py'),
			).rejects.toMatchObject({ code, runtimeState: 'running' });
		},
	);

	it('attempts abort with the known token after a lost prepare reply', async () => {
		const { instance } = makeFakeSandbox();
		const commands: string[] = [];
		const metrics = { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
		vi.spyOn(instance, 'exec').mockImplementation(async (command) => {
			commands.push(command);
			if (commands.length === 1)
				return execResult(true, JSON.stringify({ ok: true, state: 'running', generation: 0 }), '');
			if (commands.length === 2) throw new Error('provider timeout');
			return execResult(true, JSON.stringify({ ok: true, state: 'running' }), '');
		});
		await expect(
			new RuntimeCaptureClient(instance, createSandboxId(), new CaptureTelemetry(metrics)).prepare(
				'/workspace',
				'notebook.py',
			),
		).rejects.toBeInstanceOf(RuntimeCaptureError);
		const token = commands[1].match(/"token":"([^"]+)"/)![1];
		expect(commands[2]).toContain(`"token":"${token}"`);
		expect(commands[2]).toContain('"action":"abort"');
		expect(
			metrics.histogram.mock.calls
				.map(([, , tags]) => tags)
				.filter((tags) => tags?.phase?.startsWith('runtime_')),
		).toEqual([
			{ phase: 'runtime_status', outcome: 'success' },
			{ phase: 'runtime_prepare', outcome: 'failed' },
			{ phase: 'runtime_abort', outcome: 'success' },
		]);
	});
});

it.each(['running', 'paused'] as const)(
	'checks status after a lost abort response (%s)',
	async (state) => {
		const { instance } = makeFakeSandbox();
		const failure = new Error('abort response lost');
		const exec = vi
			.spyOn(instance, 'exec')
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(execResult(true, JSON.stringify({ ok: true, state }), ''));
		const runtime = new RuntimeCaptureClient(instance, createSandboxId());
		const resumed = runtime.resume({ token: crypto.randomUUID(), directory: '/checkpoint' });
		if (state === 'running') await expect(resumed).resolves.toBeUndefined();
		else await expect(resumed).rejects.toBe(failure);
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[1][0]).toContain('"action":"status"');
	},
);

it('rejects a stop acknowledgement for a different checkpoint token', async () => {
	const { instance } = makeFakeSandbox();
	vi.spyOn(instance, 'exec').mockResolvedValue(
		execResult(
			true,
			JSON.stringify({
				ok: true,
				state: 'stopped',
				token: crypto.randomUUID(),
			}),
			'',
		),
	);
	await expect(
		new RuntimeCaptureClient(instance, createSandboxId()).commitStop({
			token: crypto.randomUUID(),
			directory: '/checkpoint',
		}),
	).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
});

function nativeFixture(requestLifecycle: NonNullable<SandboxInstance['requestLifecycle']>) {
	const { instance } = makeFakeSandbox();
	const exec = vi.spyOn(instance, 'exec');
	return {
		runtime: new RuntimeCaptureClient({ ...instance, requestLifecycle }, createSandboxId()),
		exec,
	};
}

it('uses native transport for the entire capture control sequence', async () => {
	const requestLifecycle = vi.fn(async (_directory: string, request: Record<string, unknown>) =>
		JSON.stringify(
			request.action === 'prepare'
				? { ok: true, state: 'paused', token: request.token, checkpoint: '/checkpoint' }
				: { ok: true, state: 'running', generation: 0 },
		),
	);
	const { runtime, exec } = nativeFixture(requestLifecycle);
	await runtime.resume(await runtime.prepare('/workspace', 'notebook.py'));
	expect(requestLifecycle.mock.calls.map(([, request]) => request.action)).toEqual([
		'status',
		'prepare',
		'abort',
	]);
	expect(exec).not.toHaveBeenCalled();
});

it('never falls back to exec after a native request rejects', async () => {
	const { runtime, exec } = nativeFixture(vi.fn().mockRejectedValue(new Error('disconnected')));
	await expect(runtime.status()).rejects.toThrow('disconnected');
	expect(exec).not.toHaveBeenCalled();
});

it('recovers a lost native prepare response with the same checkpoint token', async () => {
	const requestLifecycle = vi
		.fn()
		.mockResolvedValueOnce(JSON.stringify({ ok: true, state: 'running', generation: 7 }))
		.mockRejectedValueOnce(new Error('disconnected'))
		.mockResolvedValueOnce(JSON.stringify({ ok: true, state: 'running' }));
	const { runtime, exec } = nativeFixture(requestLifecycle);
	await expect(runtime.prepare('/workspace', 'notebook.py')).rejects.toMatchObject({
		code: 'CAPTURE_UNAVAILABLE',
		runtimeState: 'running',
	});
	expect(requestLifecycle.mock.calls[1][1]).toMatchObject({ action: 'prepare', generation: 7 });
	expect(requestLifecycle.mock.calls[2][1]).toEqual({
		action: 'abort',
		token: requestLifecycle.mock.calls[1][1].token,
	});
	expect(exec).not.toHaveBeenCalled();
});

it.each(['{', 'null', '{}', '{"ok":"true"}', '{"ok":true,"generation":-1}'])(
	'rejects malformed native replies without replay: %s',
	async (reply) => {
		const { runtime, exec } = nativeFixture(vi.fn().mockResolvedValue(reply));
		await expect(runtime.status()).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
		expect(exec).not.toHaveBeenCalled();
	},
);

it('uses bounded exec fallback only when native dispatch was declined', async () => {
	const { runtime, exec } = nativeFixture(vi.fn().mockResolvedValue(undefined));
	exec.mockResolvedValue(execResult(true, '{"ok":true,"state":"running"}', ''));
	await expect(runtime.status()).resolves.toMatchObject({ state: 'running' });
	expect(exec).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
		timeout: 60_000,
		maxOutputBytes: 1024 * 1024,
	});
});

it.each([
	{ state: 'paused', token: crypto.randomUUID(), checkpoint: '/checkpoint' },
	{ state: 'running', checkpoint: '/checkpoint' },
	{ state: 'paused' },
])('aborts invalid native prepare acknowledgements: %j', async (reply) => {
	const requestLifecycle = vi.fn(async (_directory: string, request: Record<string, unknown>) =>
		JSON.stringify(
			request.action === 'prepare'
				? { ok: true, token: request.token, ...reply }
				: { ok: true, state: 'running', generation: 0 },
		),
	);
	const { runtime } = nativeFixture(requestLifecycle);
	await expect(runtime.prepare('/workspace', 'notebook.py')).rejects.toMatchObject({
		code: 'CAPTURE_UNAVAILABLE',
		runtimeState: 'running',
	});
	expect(requestLifecycle.mock.calls.map(([, request]) => request.action)).toEqual([
		'status',
		'prepare',
		'abort',
	]);
	expect(requestLifecycle.mock.calls[2][1].token).toBe(requestLifecycle.mock.calls[1][1].token);
});

it('keeps runtime state unknown when native prepare and recovery both fail', async () => {
	const requestLifecycle = vi
		.fn()
		.mockResolvedValueOnce('{"ok":true,"state":"running","generation":0}')
		.mockRejectedValueOnce(new Error('disconnected'))
		.mockRejectedValueOnce(new Error('abort unavailable'))
		.mockResolvedValueOnce('{"ok":true,"state":"paused"}');
	const { runtime, exec } = nativeFixture(requestLifecycle);
	await expect(runtime.prepare('/workspace', 'notebook.py')).rejects.toMatchObject({
		code: 'CAPTURE_UNAVAILABLE',
		runtimeState: 'unknown',
	});
	expect(requestLifecycle.mock.calls.map(([, request]) => request.action)).toEqual([
		'status',
		'prepare',
		'abort',
		'status',
	]);
	expect(exec).not.toHaveBeenCalled();
});

it('does not retry a native commit-stop with a mismatched token', async () => {
	const requestLifecycle = vi.fn().mockResolvedValue(
		JSON.stringify({
			ok: true,
			state: 'stopped',
			token: crypto.randomUUID(),
		}),
	);
	const { runtime, exec } = nativeFixture(requestLifecycle);
	await expect(
		runtime.commitStop({ token: crypto.randomUUID(), directory: '/checkpoint' }),
	).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
	expect(requestLifecycle).toHaveBeenCalledTimes(1);
	expect(exec).not.toHaveBeenCalled();
});

it('retains native runtime error codes without fallback', async () => {
	const { runtime, exec } = nativeFixture(
		vi.fn().mockResolvedValue('{"ok":false,"code":"CAPTURE_BUSY"}'),
	);
	await expect(runtime.status()).rejects.toMatchObject({ code: 'CAPTURE_BUSY' });
	expect(exec).not.toHaveBeenCalled();
});
