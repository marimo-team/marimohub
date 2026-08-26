import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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
});
