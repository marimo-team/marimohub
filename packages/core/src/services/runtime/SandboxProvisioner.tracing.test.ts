import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { fakeComputeFrom, makeFakeSandbox } from '../../testing';
import { SandboxProvisioner } from './SandboxProvisioner';
import type { WorkspaceLoadStrategies } from './SandboxProvisioner';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

afterEach(() => exporter.reset());
afterAll(() => {
	trace.disable();
	context.disable();
});

const projectId = createProjectId();
const notebookId = createNotebookId();
const sandboxId = createSandboxId();
const bucket = { name: 'test-bucket', endpoint: 'https://r2.example' };

describe('SandboxProvisioner tracing', () => {
	it('keeps workspace loading in the files timing when the overlay is empty', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const { instance } = makeFakeSandbox();
			instance.ready = async () => {};
			const loader = {
				async load() {
					vi.setSystemTime(Date.now() + 450);
					return { usedFallback: true };
				},
			};
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance), {
				copyOnly: loader,
				mountOrCopy: loader,
			});
			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
			});
			expect(result.timings).toMatchObject({
				files: 450,
				files_waitready: 0,
				files_non_waiting: 450,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([0, 1_000])(
		'counts readiness once with a second waiter delayed by %i ms',
		async (delay) => {
			vi.useFakeTimers();
			try {
				const { instance } = makeFakeSandbox();
				instance.ready = () => new Promise<void>((resolve) => setTimeout(resolve, 3_500));
				const loader = {
					supportsPrefetch: true,
					async load({
						waitUntilReady,
					}: Parameters<WorkspaceLoadStrategies['copyOnly']['load']>[0]) {
						await Promise.all([
							waitUntilReady?.(),
							(async () => {
								await new Promise<void>((resolve) => setTimeout(resolve, delay));
								await waitUntilReady?.();
							})(),
						]);
						await new Promise<void>((resolve) => setTimeout(resolve, 100));
						await waitUntilReady?.();
						return { usedFallback: true, stats: { objectCount: 4, bytes: 71_302 } };
					},
				};
				const result = new SandboxProvisioner(fakeComputeFrom(instance), {
					copyOnly: loader,
					mountOrCopy: loader,
				}).provision({ sandboxId, projectId, notebookId, hostname: 'localhost', bucket });
				await vi.advanceTimersByTimeAsync(3_600);
				expect((await result).timings).toMatchObject({
					reachable: 3_500,
					files: 3_600,
					files_waitready: 3_500,
					files_non_waiting: 100,
				});
				expect(
					exporter.getFinishedSpans().find((span) => span.name === 'sandbox.files')?.attributes,
				).toMatchObject({ readiness_wait_ms: 3_500, non_waiting_ms: 100 });
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it('measures injection files and environment configuration without serializing them', async () => {
		vi.useFakeTimers();
		try {
			const { instance } = makeFakeSandbox();
			instance.ready = async () => {};
			instance.writeFiles = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
			instance.setEnvVars = () => new Promise<void>((resolve) => setTimeout(resolve, 120));
			const loader = {
				async load() {
					return { usedFallback: true };
				},
			};
			const result = new SandboxProvisioner(fakeComputeFrom(instance), {
				copyOnly: loader,
				mountOrCopy: loader,
			}).provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
				sessionEnv: { vars: { TEST: 'value' }, files: [{ path: '/tmp/config', content: 'x' }] },
			});
			await vi.advanceTimersByTimeAsync(120);
			expect((await result).timings).toMatchObject({
				inject: 120,
				inject_files: 80,
				inject_env: 120,
			});
			expect(
				exporter.getFinishedSpans().find((span) => span.name === 'sandbox.inject')?.attributes,
			).toMatchObject({ files_ms: 80, environment_ms: 120 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('emits sibling spans for every provision phase with phase measurements', async () => {
		const { instance } = makeFakeSandbox();
		instance.drainTimings = () => ({ find: 7, create: 42, boot: 11 });
		const copyLoader = {
			async load() {
				return { usedFallback: true, stats: { objectCount: 2, bytes: 40 } };
			},
		};
		const loaders: WorkspaceLoadStrategies = {
			copyOnly: copyLoader,
			mountOrCopy: copyLoader,
		};
		const provisioner = new SandboxProvisioner(fakeComputeFrom(instance), loaders);
		let parentSpanId = '';

		await provider
			.getTracer('test')
			.startActiveSpan('SessionService.createSession', async (parent) => {
				parentSpanId = parent.spanContext().spanId;
				try {
					await provisioner.provision({
						sandboxId,
						projectId,
						notebookId,
						hostname: 'localhost',
						bucket,
						workspaceLoadMode: 'copy-only',
						launchStrategy: 'uv-script-pins',
						sessionEnv: { vars: { TOKEN: 'secret' } },
					});
				} finally {
					parent.end();
				}
			});

		const spans = exporter.getFinishedSpans().filter((span) => span.name.startsWith('sandbox.'));
		expect(spans.map((span) => span.name).sort()).toEqual(
			[
				'sandbox.expose',
				'sandbox.files',
				'sandbox.inject',
				'sandbox.reachable',
				'sandbox.setup',
				'sandbox.start',
				'sandbox.waitport',
			].sort(),
		);
		for (const span of spans) {
			expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
		}
		expect(spans.find((span) => span.name === 'sandbox.reachable')?.attributes).toMatchObject({
			find_ms: 7,
			create_ms: 42,
			boot_ms: 11,
		});
		expect(spans.find((span) => span.name === 'sandbox.files')?.attributes).toMatchObject({
			objects: 2,
			bytes: 40,
			used_fallback: true,
		});
		expect(spans.find((span) => span.name === 'sandbox.setup')?.attributes).toMatchObject({
			launch_strategy: 'uv-script-pins',
		});
	});

	it('marks a failed phase as an error', async () => {
		const { instance } = makeFakeSandbox({ failWaitForPort: new Error('kernel exited') });
		const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

		await expect(
			provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket,
			}),
		).rejects.toThrow('Failed to start sandbox while starting the marimo kernel');

		const span = exporter
			.getFinishedSpans()
			.find((candidate) => candidate.name === 'sandbox.waitport');
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
	});

	it('includes the active trace context on slow setup logs', async () => {
		const { instance } = makeFakeSandbox();
		instance.ready = async () => {};
		const exec = instance.exec.bind(instance);
		instance.exec = async (command, options) => {
			if (!command.includes('uv sync')) return exec(command, options);
			vi.setSystemTime(Date.now() + 2_500);
			return {
				success: true,
				stdout: '',
				stderr: [
					'__MARIMOHUB_SETUP__ step pyproject_layer 1000000000',
					'__MARIMOHUB_SETUP__ complete 3500000000',
				].join('\n'),
			};
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-26T13:47:00Z'));
		try {
			let expectedTraceId = '';
			let expectedSpanId = '';
			await provider.getTracer('test').startActiveSpan('session.provision', async (span) => {
				expectedTraceId = span.spanContext().traceId;
				expectedSpanId = span.spanContext().spanId;
				try {
					await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
						sandboxId,
						projectId,
						notebookId,
						hostname: 'localhost',
						bucket,
					});
				} finally {
					span.end();
				}
			});

			const record = JSON.parse(String(warn.mock.calls[0][0])) as Record<string, unknown>;
			expect(record).toMatchObject({ trace_id: expectedTraceId, span_id: expectedSpanId });
		} finally {
			vi.useRealTimers();
			warn.mockRestore();
		}
	});
});

it('drains data-plane timings and counters after combined preparation finishes', async () => {
	const { instance } = makeFakeSandbox();
	Object.assign(instance, { supportsLaunchSetupOutput: true });
	instance.ready = async () => {};
	let transferred = false;
	const writeFiles = instance.writeFiles.bind(instance);
	instance.writeFiles = async (files) => {
		await writeFiles(files);
		transferred = true;
	};
	instance.drainTimings = (): Record<string, number> =>
		transferred ? { first_dataplane: 14 } : {};
	instance.drainCounters = () => ({
		execs: 0,
		file_writes: 1,
		file_write_waves: 1,
		env_writes: 1,
		stream_execs: 2,
		status_polls: 1,
	});
	instance.launchProcess = async (command, options) => ({
		success: true,
		process: await instance.startProcess(command, options),
		setupOutput: { stdout: '', stderr: '' },
		timings: { setup: 5, start: 2, waitport: 1 },
	});
	const result = await new SandboxProvisioner(fakeComputeFrom(instance)).provision({
		sandboxId,
		projectId,
		notebookId,
		hostname: 'localhost',
		bucket,
		sessionEnv: {
			files: [{ path: '/tmp/config', content: 'value' }],
			vars: { CONFIG: '/tmp/config' },
		},
	});
	expect(result.timings).toMatchObject({ first_dataplane: 14, setup: 5, start: 2, waitport: 1 });
	expect(result.counters).toMatchObject({
		file_writes: 1,
		file_write_waves: 1,
		env_writes: 1,
		stream_execs: 2,
		status_polls: 1,
	});
});
