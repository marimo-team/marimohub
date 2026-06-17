import { describe, expect, it } from 'vitest';
import { Stopwatch } from './timing';

/** A controllable clock so durations are exact, not flaky wall-clock reads. */
function fakeClock(): {
	now: () => number;
	set: (t: number) => void;
	advance: (d: number) => void;
} {
	let t = 0;
	return {
		now: () => t,
		set: (v) => {
			t = v;
		},
		advance: (d) => {
			t += d;
		},
	};
}

describe('Stopwatch', () => {
	it('records a span stopped by the `using` keyword at scope exit', () => {
		const clock = fakeClock();
		const sw = new Stopwatch(clock.now);
		{
			using _ = sw.span('reachable');
			clock.advance(50);
		} // _ disposed here → records elapsed
		expect(sw.timings.reachable).toBe(50);
	});

	it('records via explicit stop() and is idempotent', () => {
		const clock = fakeClock();
		const sw = new Stopwatch(clock.now);
		const span = sw.span('phase');
		clock.set(30);
		expect(span.stop()).toBe(30);
		clock.set(9999); // a later stop must not overwrite
		expect(span.stop()).toBe(30);
		expect(sw.timings.phase).toBe(30);
	});

	it('time() records async work and returns its result', async () => {
		const clock = fakeClock();
		const sw = new Stopwatch(clock.now);
		const result = await sw.time('work', async () => {
			clock.advance(12);
			return 42;
		});
		expect(result).toBe(42);
		expect(sw.timings.work).toBe(12);
	});

	it('time() records the duration even when the operation throws', async () => {
		const clock = fakeClock();
		const sw = new Stopwatch(clock.now);
		await expect(
			sw.time('boom', async () => {
				clock.advance(10);
				throw new Error('kaboom');
			}),
		).rejects.toThrow('kaboom');
		expect(sw.timings.boom).toBe(10);
	});

	it('accumulates independent phases into one record', async () => {
		const clock = fakeClock();
		const sw = new Stopwatch(clock.now);
		await sw.time('a', async () => clock.advance(5));
		await sw.time('b', async () => clock.advance(7));
		expect(sw.timings).toEqual({ a: 5, b: 7 });
	});

	it('defaults to a real monotonic-enough clock when none is injected', async () => {
		const sw = new Stopwatch();
		await sw.time('real', async () => {
			await new Promise((r) => setTimeout(r, 5));
		});
		expect(sw.timings.real).toBeGreaterThanOrEqual(0);
	});
});
