import { describe, expect, it } from 'vitest';
import { WideEventMetrics } from './metrics';

describe('WideEventMetrics', () => {
	it('accumulates repeated increments', () => {
		const metrics = new WideEventMetrics();
		metrics.increment('cas_conflicts');
		metrics.increment('cas_conflicts', 2);
		expect(metrics.collect()).toMatchObject({ 'counter.cas_conflicts': 3 });
	});

	it('keeps only the latest gauge value', () => {
		const metrics = new WideEventMetrics();
		metrics.gauge('live_sessions', 5);
		metrics.gauge('live_sessions', 8);
		expect(metrics.collect()).toMatchObject({ 'gauge.live_sessions': 8 });
	});

	it('flattens counters and gauges under prefixed keys', () => {
		const metrics = new WideEventMetrics();
		metrics.increment('a');
		metrics.gauge('b', 1);
		expect(metrics.collect()).toEqual({ 'counter.a': 1, 'gauge.b': 1 });
	});
});
