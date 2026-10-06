import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ApiDeps } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { MaintenanceLock, Millis, paths, WarmPoolService, WarmPoolStore } from '@marimo-hub/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startJobScheduler, startMaintenance, startSessionLifecycle, startWarmPools } from './cron';
import { WideEventMetrics } from './metrics';
import { BackgroundLoops } from './backgroundLoops';
import { flushRun, makeSessionLifetime, useLoopHarness } from './test/loopHarness';

async function storedLease(deps: ApiDeps, key: string) {
	const lease = await (await deps.bucket.get(key))!.json<{ expires_at: string }>();
	return Date.parse(lease.expires_at);
}

function span(spans: ReadableSpan[], name: string): ReadableSpan {
	const found = spans.find((span) => span.name === name);
	expect(found, name).toBeDefined();
	return found!;
}

function expectChildOf(child: ReadableSpan, parent: ReadableSpan) {
	expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
	expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
}

describe('maintenance tracing', () => {
	const h = useLoopHarness();
	let deps: ApiDeps;
	let exporter: InMemorySpanExporter;
	let provider: NodeTracerProvider;

	beforeEach(async () => {
		deps = makeTestDeps(await createInitializedBucket());
		exporter = new InMemorySpanExporter();
		provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		provider.register();
	});

	afterEach(async () => {
		await provider.shutdown();
		trace.disable();
		context.disable();
	});

	it.each([
		['maintenance', 'maintenance'],
		['sessionLifecycle', 'session_lifecycle'],
		['jobScheduler', 'job_scheduler'],
		['warmPool', 'warm_pool'],
	] as const)(
		'traces %s lock acquisition and release under the loop span',
		async (loop, loopName) => {
			const metrics = new WideEventMetrics();
			const loops = new BackgroundLoops();
			const run = vi.fn(async () => {});
			const start = loops.start.bind(loops);
			vi.spyOn(loops, 'start').mockImplementation((options) =>
				start({ ...options, run, onSuccess: undefined }),
			);
			switch (loop) {
				case 'maintenance':
					h.track(startMaintenance(deps, metrics, loops));
					break;
				case 'sessionLifecycle':
					deps.sandbox.sessionLifetime = makeSessionLifetime();
					h.track(startSessionLifecycle(deps, loops));
					break;
				case 'jobScheduler':
					h.track(startJobScheduler(deps, metrics, loops));
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
					h.track(startWarmPools(deps, loops));
			}
			await flushRun();
			const spans = exporter.getFinishedSpans();
			expect(run).toHaveBeenCalledOnce();
			const parent = span(spans, `loop.${loopName}`);
			const acquire = span(spans, 'MaintenanceLock.acquire');
			const release = span(spans, 'MaintenanceLock.release');
			expectChildOf(acquire, parent);
			expectChildOf(release, parent);
			const key = paths[`${loop}Lock`];
			expect(acquire.attributes).toEqual({ 'bucket.key': key, 'marimohub.lock.acquired': true });
			expect(release.attributes).toEqual({ 'bucket.key': key });
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
		h.track(startMaintenance(deps, new WideEventMetrics()));
		await flushRun();
		const spans = exporter.getFinishedSpans();
		expect(spans.map((span) => span.name).sort()).toEqual([
			'MaintenanceLock.acquire',
			'loop.maintenance',
		]);
		const acquire = span(spans, 'MaintenanceLock.acquire');
		expect(acquire.attributes['marimohub.lock.acquired']).toBe(false);
		expect(acquire.status.code).toBe(SpanStatusCode.UNSET);
		expect(acquire.events).toEqual([]);
		expect(span(spans, 'loop.maintenance').status.code).toBe(SpanStatusCode.UNSET);
		expect(await storedLease(deps, paths.maintenanceLock)).toBeGreaterThan(Date.now());
	});

	it('records a storage read failure during lease release', async () => {
		const get = deps.bucket.get.bind(deps.bucket);
		vi.spyOn(deps.bucket, 'get').mockImplementation((key) => {
			if (key === paths.maintenanceLock) return Promise.reject(new Error('lease read failed'));
			return get(key);
		});
		h.track(startMaintenance(deps, new WideEventMetrics()));
		await flushRun();
		const release = span(exporter.getFinishedSpans(), 'MaintenanceLock.release');
		expect(release.status.code).toBe(SpanStatusCode.ERROR);
		expect(release.attributes).toEqual({ 'bucket.key': paths.maintenanceLock });
		expect(release.events).toContainEqual(
			expect.objectContaining({
				name: 'exception',
				attributes: expect.objectContaining({ 'exception.message': 'lease read failed' }),
			}),
		);
		vi.mocked(deps.bucket.get).mockRestore();
		expect(await storedLease(deps, paths.maintenanceLock)).toBeGreaterThan(Date.now());
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
		h.track(startMaintenance(deps, new WideEventMetrics()));
		await flushRun();
		const spans = exporter.getFinishedSpans();
		const name = step === 'lock' ? 'MaintenanceLock.acquire' : 'Maintenance.sweepAppPools';
		const failed = span(spans, name);
		expect(failed.status.code).toBe(SpanStatusCode.ERROR);
		expect(failed.events.some((event) => event.name === 'exception')).toBe(true);
		const parent = span(spans, 'loop.maintenance');
		expectChildOf(failed, parent);
		expect(parent.status.code).toBe(SpanStatusCode.ERROR);
		if (step === 'app_pool') {
			expect(span(spans, 'MaintenanceLock.release').status.code).toBe(SpanStatusCode.UNSET);
			expect(await storedLease(deps, paths.maintenanceLock)).toBeLessThanOrEqual(Date.now());
		} else {
			expect(spans.map((span) => span.name).sort()).toEqual([
				'MaintenanceLock.acquire',
				'loop.maintenance',
			]);
		}
	});
});
