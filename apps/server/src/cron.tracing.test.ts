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
	] as const)('traces %s lease ownership through its lifecycle', async (loop, loopName) => {
		const metrics = new WideEventMetrics();
		const loops = new BackgroundLoops();
		const run = vi.fn(async () => {});
		let stop: () => void;
		const start = loops.start.bind(loops);
		vi.spyOn(loops, 'start').mockImplementation((options) =>
			start({ ...options, run, onSuccess: undefined }),
		);
		switch (loop) {
			case 'maintenance':
				stop = h.track(startMaintenance(deps, metrics, loops));
				break;
			case 'sessionLifecycle':
				deps.sandbox.sessionLifetime = makeSessionLifetime();
				stop = h.track(startSessionLifecycle(deps, loops))!;
				break;
			case 'jobScheduler':
				stop = h.track(startJobScheduler(deps, metrics, loops)).stop;
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
				stop = h.track(startWarmPools(deps, loops))!.stop;
		}
		await flushRun();
		const spans = exporter.getFinishedSpans();
		expect(run).toHaveBeenCalledTimes(loop === 'maintenance' ? 5 : 1);
		const parent = span(spans, `loop.${loopName}`);
		const children = spans.filter(
			(child) => child.spanContext().traceId === parent.spanContext().traceId,
		);
		const retained = loop === 'jobScheduler' || loop === 'warmPool';
		const acquire = span(children, retained ? 'MaintenanceLock.hold' : 'MaintenanceLock.acquire');
		expectChildOf(acquire, parent);
		const key = paths[`${loop}Lock`];
		expect(acquire.attributes).toEqual({ 'bucket.key': key, 'marimohub.lock.acquired': true });
		if (retained) {
			expect(children.some((child) => child.name === 'MaintenanceLock.release')).toBe(false);
			expect(await storedLease(deps, key)).toBeGreaterThan(Date.now());
		} else {
			const release = span(children, 'MaintenanceLock.release');
			expectChildOf(release, parent);
			expect(release.attributes).toEqual({ 'bucket.key': key });
		}
		stop();
		await loops.drain();
		if (retained) {
			const release = span(
				exporter.getFinishedSpans().filter((child) => child.attributes['bucket.key'] === key),
				'MaintenanceLock.release',
			);
			expect(release.status.code).toBe(SpanStatusCode.UNSET);
			expect(release.parentSpanContext).toBeUndefined();
		}
		expect(await storedLease(deps, key)).toBeLessThanOrEqual(Date.now());
	});

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
		const all = exporter.getFinishedSpans();
		const parent = span(all, 'loop.maintenance');
		const spans = all.filter(
			(child) => child.spanContext().traceId === parent.spanContext().traceId,
		);
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

	it('records a failure during lease release', async () => {
		vi.spyOn(MaintenanceLock.prototype, 'release').mockRejectedValue(
			new Error('lease release failed'),
		);
		h.track(startMaintenance(deps, new WideEventMetrics()));
		await flushRun();
		const all = exporter.getFinishedSpans();
		const parent = span(all, 'loop.maintenance');
		const release = span(
			all.filter((child) => child.spanContext().traceId === parent.spanContext().traceId),
			'MaintenanceLock.release',
		);
		expect(release.status.code).toBe(SpanStatusCode.ERROR);
		expect(release.attributes).toEqual({ 'bucket.key': paths.maintenanceLock });
		expect(release.events).toContainEqual(
			expect.objectContaining({
				name: 'exception',
				attributes: expect.objectContaining({ 'exception.message': 'lease release failed' }),
			}),
		);
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
		const all = exporter.getFinishedSpans();
		const parent = span(all, step === 'app_pool' ? 'loop.app_pools' : 'loop.maintenance');
		const spans = all.filter(
			(child) => child.spanContext().traceId === parent.spanContext().traceId,
		);
		const name = step === 'lock' ? 'MaintenanceLock.acquire' : 'Maintenance.sweepAppPools';
		const failed = span(spans, name);
		expect(failed.status.code).toBe(SpanStatusCode.ERROR);
		expect(failed.events.some((event) => event.name === 'exception')).toBe(true);
		expectChildOf(failed, parent);
		expect(parent.status.code).toBe(SpanStatusCode.ERROR);
		if (step === 'app_pool') {
			expect(span(spans, 'MaintenanceLock.hold').status.code).toBe(SpanStatusCode.UNSET);
			expect(spans.some((child) => child.name === 'MaintenanceLock.release')).toBe(false);
			expect(await storedLease(deps, '_system/app-pool-maintenance-lock.json')).toBeGreaterThan(
				Date.now(),
			);
		} else {
			expect(spans.map((span) => span.name).sort()).toEqual([
				'MaintenanceLock.acquire',
				'loop.maintenance',
			]);
		}
	});
});
