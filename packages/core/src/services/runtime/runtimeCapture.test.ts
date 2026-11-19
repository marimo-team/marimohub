import { CaptureTelemetry } from '../../internal/captureTelemetry';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxId } from '../../ids';
import { execResult } from '../../ports/sandbox';
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
		expect(metrics.histogram.mock.calls.map(([, , tags]) => tags)).toEqual([
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
