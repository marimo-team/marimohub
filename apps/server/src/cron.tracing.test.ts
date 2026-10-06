import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ApiDeps } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { MaintenanceLock, Millis, paths, WarmPoolService, WarmPoolStore } from '@marimo-hub/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startJobScheduler, startMaintenance, startSessionLifecycle, startWarmPools } from './cron';
import { WideEventMetrics } from './metrics';

describe('maintenance tracing', () => {
	let deps: ApiDeps;
	let exporter: InMemorySpanExporter;
	let provider: NodeTracerProvider;
	let stop: (() => void) | undefined;

	beforeEach(async () => {
		deps = makeTestDeps(await createInitializedBucket());
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

	it('does not report lock contention as an error or sweep without the lease', async () => {
		await deps.bucket.put(
			paths.maintenanceLock,
			JSON.stringify({
				holder: 'other-replica',
				expires_at: new Date(Date.now() + Millis.minutes(10)).toISOString(),
			}),
		);
		stop = startMaintenance(deps, new WideEventMetrics());
		await vi.advanceTimersByTimeAsync(0);
		const spans = exporter.getFinishedSpans();
		expect(spans.map((span) => span.name)).toEqual(['MaintenanceLock.acquire']);
		expect(spans[0].status.code).toBe(SpanStatusCode.UNSET);
		expect(spans[0].events).toEqual([]);
		expect(await deps.bucket.head(paths.maintenanceLock)).not.toBeNull();
	});

	it('records a storage read failure during lease release', async () => {
		const get = deps.bucket.get.bind(deps.bucket);
		vi.spyOn(deps.bucket, 'get').mockImplementation((key) => {
			if (key === paths.maintenanceLock) return Promise.reject(new Error('lease read failed'));
			return get(key);
		});
		stop = startMaintenance(deps, new WideEventMetrics());
		await vi.advanceTimersByTimeAsync(0);
		const span = exporter
			.getFinishedSpans()
			.find((span) => span.name === 'MaintenanceLock.release');
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes).toEqual({ 'marimohub.lock.key': paths.maintenanceLock });
		expect(span?.events).toContainEqual(
			expect.objectContaining({
				name: 'exception',
				attributes: expect.objectContaining({ 'exception.message': 'lease read failed' }),
			}),
		);
		expect(await deps.bucket.head(paths.maintenanceLock)).not.toBeNull();
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining('"event":"maintenance_release_failed"'),
		);
	});

	it.each(['lock', 'app_pool'] as const)('records failed %s steps as errors', async (step) => {
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
		if (step === 'app_pool') {
			expect(
				exporter.getFinishedSpans().find((span) => span.name === 'MaintenanceLock.release')?.status
					.code,
			).toBe(SpanStatusCode.UNSET);
			expect(await deps.bucket.head(paths.maintenanceLock)).toBeNull();
		} else {
			expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
				'MaintenanceLock.acquire',
			]);
		}
	});
});
