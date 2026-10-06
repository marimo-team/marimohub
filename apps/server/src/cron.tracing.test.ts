import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { MaintenanceLock, Millis, paths, WarmPoolService, WarmPoolStore } from '@marimo-hub/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startJobScheduler, startMaintenance, startSessionLifecycle, startWarmPools } from './cron';
import { WideEventMetrics } from './metrics';

describe('maintenance tracing', () => {
	let exporter: InMemorySpanExporter;
	let provider: NodeTracerProvider;
	let stop: (() => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		exporter = new InMemorySpanExporter();
		provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		provider.register();
	});

	afterEach(async () => {
		stop?.();
		await provider.shutdown();
		trace.disable();
		context.disable();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each(['maintenance', 'sessionLifecycle', 'jobScheduler', 'warmPool'] as const)(
		'traces %s lock acquisition and release with the lock key',
		async (loop) => {
			const deps = makeTestDeps(await createInitializedBucket());
			const metrics = new WideEventMetrics();
			switch (loop) {
				case 'maintenance':
					stop = startMaintenance(deps, metrics);
					break;
				case 'sessionLifecycle':
					deps.sandbox.sessionLifetime = {
						maxLifetimeMs: Millis.minutes(1),
						idleTimeoutMsByMode: { edit: Millis.seconds(30), app: Millis.seconds(30) },
						extensionMs: Millis.seconds(30),
						connectionAware: false,
						snapshotIntervalMs: Millis.seconds(30),
						sweepIntervalMs: Millis.seconds(5),
					};
					stop = startSessionLifecycle(deps);
					break;
				case 'jobScheduler':
					stop = startJobScheduler(deps, metrics).stop;
					break;
				case 'warmPool':
					deps.warmPool = new WarmPoolService(
						new WarmPoolStore(deps.bucket, 'kubernetes'),
						deps.compute,
						deps.services.sessions,
						{
							enabled: true,
							size: 1,
							profiles: [],
							creationTimeoutMs: 300_000,
							minimumRemainingMs: 60_000,
						},
					);
					vi.spyOn(deps.warmPool, 'sweep').mockResolvedValue(undefined);
					stop = startWarmPools(deps)!.stop;
			}
			await vi.advanceTimersByTimeAsync(0);
			const spans = exporter.getFinishedSpans();
			for (const phase of ['acquire', 'release']) {
				const span = spans.find((span) => span.name === `MaintenanceLock.${phase}`);
				expect(span?.attributes).toEqual({ 'marimohub.lock.key': paths[`${loop}Lock`] });
			}
			if (loop === 'maintenance' || loop === 'sessionLifecycle') {
				expect(spans.some((span) => span.name === 'Maintenance.sweepAppPools')).toBe(true);
			}
		},
	);

	it.each(['lock', 'app_pool'] as const)('records failed %s steps as errors', async (step) => {
		const deps = makeTestDeps(await createInitializedBucket());
		if (step === 'lock') {
			vi.spyOn(MaintenanceLock.prototype, 'acquire').mockRejectedValue(new Error('bucket down'));
		} else {
			vi.spyOn(deps.bucket, 'list').mockRejectedValue(new Error('bucket down'));
		}
		stop = startMaintenance(deps, new WideEventMetrics());
		await vi.advanceTimersByTimeAsync(0);
		const name = step === 'lock' ? 'MaintenanceLock.acquire' : 'Maintenance.sweepAppPools';
		const span = exporter.getFinishedSpans().find((span) => span.name === name);
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
	});
});
