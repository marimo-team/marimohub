import { deferOrAwait } from '@marimo-hub/core';
import { context, createContextKey, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it, vi } from 'vitest';
import { DeferredWorkQueue } from './backgroundWork';
import { WideEventMetrics } from './metrics';

describe('DeferredWorkQueue', () => {
	it('starts teardown independently of long-lived turns and saturated ordinary work', async () => {
		const queue = new DeferredWorkQueue(new WideEventMetrics(), { concurrency: 1 });
		const gate = Promise.withResolvers<void>();
		const stopped = vi.fn(async () => {});
		for (let i = 0; i < 100; i++) {
			expect(queue.defer('conversation.turn', () => gate.promise)).toBeUndefined();
		}
		void queue.defer('audit', () => gate.promise);
		for (let i = 0; i < 100; i++) expect(queue.defer('session.stop', stopped)).toBeUndefined();
		await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(100));
		gate.resolve();
		await queue.drain();
	});

	it('drains teardown scheduled by a settling long-lived task, including failure', async () => {
		const queue = new DeferredWorkQueue(new WideEventMetrics());
		const stopped = vi.fn(async () => {
			throw new Error('provider unavailable');
		});
		void queue.defer('surface.start', async () => {
			void queue.defer('session.stop', stopped);
		});
		await queue.drain();
		expect(stopped).toHaveBeenCalledOnce();
	});
	it('tracks teardown overflow and waits for its failure during shutdown', async () => {
		const metrics = new WideEventMetrics();
		const queue = new DeferredWorkQueue(metrics);
		const capacity = Promise.withResolvers<void>();
		const overflow = Promise.withResolvers<void>();
		const queued = vi.fn(() => capacity.promise);
		for (let index = 0; index < 16 + 256; index++)
			expect(queue.defer('session.stop', queued)).toBeUndefined();
		expect(queue.defer('session.stop', () => overflow.promise)).toBeUndefined();
		let drained = false;
		const draining = queue.drain().then(() => {
			drained = true;
		});
		capacity.resolve();
		await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(272));
		expect(drained).toBe(false);
		overflow.reject(new Error('teardown failed'));
		await draining;
		expect(metrics.collect()['counter.background.inline_fallback{"label":"session.stop"}']).toBe(1);
	});
	it('bounds a burst globally and per label, drains queued tasks, and skips blocked labels', async () => {
		const metrics = new WideEventMetrics();
		const queue = new DeferredWorkQueue(metrics, {
			concurrency: 3,
			perLabelConcurrency: 2,
			perLabelQueueSize: 100,
		});
		let running = 0;
		let maxRunning = 0;
		const byLabel = new Map<string, number>();
		const maxima = new Map<string, number>();
		const gate = Promise.withResolvers<void>();
		let finished = 0;
		for (let i = 0; i < 100; i++) {
			const label = i < 70 ? 'teardown' : 'audit';
			expect(
				queue.defer(label, async () => {
					running++;
					maxRunning = Math.max(maxRunning, running);
					const count = (byLabel.get(label) ?? 0) + 1;
					byLabel.set(label, count);
					maxima.set(label, Math.max(maxima.get(label) ?? 0, count));
					await gate.promise;
					running--;
					byLabel.set(label, byLabel.get(label)! - 1);
					finished++;
				}),
			).toBeUndefined();
		}
		await Promise.resolve();
		expect(maxRunning).toBe(3);
		expect(byLabel.get('audit')).toBe(1);
		expect(metrics.collect()['gauge.background.queue_depth']).toBe(97);
		let drained = false;
		const draining = queue.drain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		gate.resolve();
		await draining;
		expect(finished).toBe(100);
		expect(maxRunning).toBe(3);
		expect([...maxima.values()].every((value) => value <= 2)).toBe(true);
		expect(metrics.collect()).toMatchObject({
			'gauge.background.queue_depth': 0,
			'gauge.background.running': 0,
		});
	});

	it.each(['global', 'label'])(
		'awaits overflow inline when the %s queue bound is reached',
		async (bound) => {
			const metrics = new WideEventMetrics();
			const queue = new DeferredWorkQueue(metrics, {
				concurrency: 1,
				perLabelConcurrency: 1,
				queueSize: bound === 'global' ? 1 : 10,
				perLabelQueueSize: bound === 'label' ? 1 : 10,
			});
			const gate = Promise.withResolvers<void>();
			const run = vi.fn(() => gate.promise);
			void queue.defer('teardown', run);
			void queue.defer('teardown', run);
			const overflow = queue.defer('teardown', run);
			expect(overflow).toBeInstanceOf(Promise);
			await Promise.resolve();
			expect(run).toHaveBeenCalledTimes(2);
			expect(metrics.collect()['gauge.background.queue_depth']).toBe(1);
			expect(metrics.collect()['counter.background.inline_fallback{"label":"teardown"}']).toBe(1);
			gate.resolve();
			await overflow;
			await queue.drain();
			expect(run).toHaveBeenCalledTimes(3);
		},
	);

	it('retains the submitting trace context when another task starts queued work', async () => {
		const provider = new NodeTracerProvider();
		provider.register();
		const key = createContextKey('request');
		const seen: unknown[] = [];
		const queue = new DeferredWorkQueue(new WideEventMetrics(), { concurrency: 1 });
		try {
			for (const request of ['first', 'second']) {
				context.with(context.active().setValue(key, request), () => {
					void queue.defer('teardown', async () => {
						seen.push(context.active().getValue(key));
					});
				});
			}
			await queue.drain();
			expect(seen).toEqual(['first', 'second']);
		} finally {
			context.disable();
			trace.disable();
			await provider.shutdown();
		}
	});

	it('releases capacity after rejection and drains nested tasks', async () => {
		const queue = new DeferredWorkQueue(new WideEventMetrics(), { concurrency: 1 });
		const nested = vi.fn(async () => {});
		void queue.defer('teardown', async () => {
			throw new Error('failed');
		});
		void queue.defer('teardown', async () => {
			void queue.defer('audit', nested);
		});
		await queue.drain();
		expect(nested).toHaveBeenCalledOnce();
	});
	it('keeps executing and draining work when the metrics sink throws', async () => {
		const fail = vi.fn(() => {
			throw new Error('metrics unavailable');
		});
		const queue = new DeferredWorkQueue(
			{ increment: fail, gauge: fail },
			{
				concurrency: 1,
				perLabelConcurrency: 1,
				queueSize: 1,
			},
		);
		const gate = Promise.withResolvers<void>();
		const queued = vi.fn(async () => {});
		const overflow = vi.fn(async () => {});
		void queue.defer('teardown', () => gate.promise);
		void queue.defer('teardown', queued);
		await queue.defer('teardown', overflow);
		gate.resolve();
		await queue.drain();
		expect(queued).toHaveBeenCalledOnce();
		expect(overflow).toHaveBeenCalledOnce();
		const next = vi.fn(async () => {});
		void queue.defer('teardown', next);
		await queue.drain();
		expect(next).toHaveBeenCalledOnce();
		expect(fail).toHaveBeenCalled();
	});
	it.each([
		{ concurrency: 0 },
		{ concurrency: -1 },
		{ concurrency: 1.5 },
		{ concurrency: Number.NaN },
		{ concurrency: Number.POSITIVE_INFINITY },
		{ perLabelConcurrency: 0 },
		{ queueSize: 0 },
		{ perLabelQueueSize: 0 },
	])('rejects invalid limits %j', (limits) => {
		expect(() => new DeferredWorkQueue(new WideEventMetrics(), limits)).toThrow(RangeError);
	});

	it('waits for failing inline overflow during drain and runs a queued task after a synchronous throw', async () => {
		const metrics = new WideEventMetrics();
		const queue = new DeferredWorkQueue(metrics, { concurrency: 1, queueSize: 2 });
		const activeGate = Promise.withResolvers<void>();
		const overflowGate = Promise.withResolvers<void>();
		const queuedFinished = Promise.withResolvers<void>();
		const synchronousFailure = vi.fn(() => {
			throw new Error('synchronous failure');
		});
		const overflow = vi.fn(() => overflowGate.promise);
		void queue.defer('teardown', () => activeGate.promise);
		void queue.defer('teardown', synchronousFailure);
		void queue.defer('teardown', async () => {
			queuedFinished.resolve();
		});
		const failure = new Error('overflow failed');
		const rejected = expect(queue.defer('teardown', overflow)).rejects.toBe(failure);
		let drained = false;
		const draining = queue.drain().then(() => {
			drained = true;
		});
		activeGate.resolve();
		await queuedFinished.promise;
		expect(drained).toBe(false);
		overflowGate.reject(failure);
		await rejected;
		await draining;
		expect(overflow).toHaveBeenCalledOnce();
		expect(synchronousFailure).toHaveBeenCalledOnce();
		expect(metrics.collect()).toMatchObject({
			'gauge.background.queue_depth': 0,
			'gauge.background.running': 0,
			'counter.background.inline_fallback{"label":"teardown"}': 1,
		});
	});
	it('reports an inline task failure once through the core guard without retrying cleanup', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const metrics = new WideEventMetrics();
		const queue = new DeferredWorkQueue(metrics, { concurrency: 1, queueSize: 1 });
		const gate = Promise.withResolvers<void>();
		const cleanup = vi.fn(async () => {
			throw new Error('provider unavailable');
		});
		try {
			void queue.defer('teardown', () => gate.promise);
			void queue.defer('teardown', async () => {});
			await expect(deferOrAwait(queue, 'teardown', cleanup, metrics)).resolves.toBeUndefined();
			expect(cleanup).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining('background_work_failed'),
			);
			expect(metrics.collect()).toMatchObject({
				'counter.background.failed{"label":"teardown"}': 1,
				'counter.background.inline_fallback{"label":"teardown"}': 1,
				'gauge.background.in_flight{"label":"teardown"}': 0,
				'histogram.background.duration_ms{"label":"teardown"}.count': 1,
			});
		} finally {
			gate.resolve();
			await queue.drain();
			log.mockRestore();
		}
	});
});

it('rejects explicit admission at capacity without executing inline, then drains admitted work', async () => {
	const queue = new DeferredWorkQueue(new WideEventMetrics(), { concurrency: 1, queueSize: 1 });
	const gate = Promise.withResolvers<void>();
	const overflow = vi.fn(async () => {});
	expect(queue.tryDefer('migration.attempt', () => gate.promise)).toBe(true);
	expect(queue.tryDefer('migration.attempt', () => gate.promise)).toBe(true);
	expect(queue.tryDefer('migration.attempt', overflow)).toBe(false);
	await Promise.resolve();
	expect(overflow).not.toHaveBeenCalled();
	gate.resolve();
	await queue.drain();
	expect(queue.tryDefer('migration.attempt', overflow)).toBe(true);
	await queue.drain();
	expect(overflow).toHaveBeenCalledOnce();
});
