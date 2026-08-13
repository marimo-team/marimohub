import { describe, expect, it, vi } from 'vitest';
import { InFlightWork, KeyedAdmission, mapWithConcurrency, Semaphore } from './concurrency';

describe('Semaphore', () => {
	it.each([0, -1, 1.5, Number.NaN])('rejects an invalid permit count: %s', (permits) => {
		expect(() => new Semaphore(permits)).toThrow(/positive integer/);
	});

	it('releases a permit when work rejects and rejects over-release', async () => {
		const semaphore = new Semaphore(1);
		await expect(
			semaphore.run(async () => {
				throw new Error('failed');
			}),
		).rejects.toThrow('failed');
		expect(semaphore.available).toBe(1);
		expect(() => semaphore.release()).toThrow(/more times than acquire/);
	});
});

describe('mapWithConcurrency', () => {
	it('rejects invalid concurrency even for empty input', () => {
		expect(() => mapWithConcurrency([], 0, async () => 1)).toThrow(/positive integer/);
	});

	it('rejects a failed item without leaking permits to later work', async () => {
		const started: number[] = [];
		await expect(
			mapWithConcurrency([1, 2, 3], 1, async (value) => {
				started.push(value);
				if (value === 2) throw new Error('item failed');
				return value;
			}),
		).rejects.toThrow('item failed');
		await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
	});
});

describe('KeyedAdmission', () => {
	it('supports manually held, idempotently released permits', () => {
		const admission = new KeyedAdmission(1, 1, {
			global: () => new Error('global limit'),
			perKey: () => new Error('key limit'),
		});
		const release = admission.acquire('a');
		expect(admission.activeCount).toBe(1);
		expect(admission.activeFor('a')).toBe(1);
		expect(() => admission.acquire('b')).toThrow('global limit');
		release();
		release();
		expect(admission.activeCount).toBe(0);
	});

	it('reconfigures limits without forgetting active work', () => {
		const admission = new KeyedAdmission(1, 1, {
			global: () => new Error('global limit'),
			perKey: () => new Error('key limit'),
		});
		const first = admission.acquire('a');

		admission.reconfigure(2, 2);
		const second = admission.acquire('a');
		expect(admission.activeCount).toBe(2);
		expect(admission.activeFor('a')).toBe(2);
		expect(() => admission.acquire('a')).toThrow('key limit');
		expect(() => admission.acquire('b')).toThrow('global limit');

		first();
		second();
		expect(admission.activeCount).toBe(0);
	});

	it('enforces global and keyed limits and releases completed work', async () => {
		const admission = new KeyedAdmission(2, 1, {
			global: () => new Error('global limit'),
			perKey: () => new Error('key limit'),
		});
		let finishFirst: (() => void) | undefined;
		let finishSecond: (() => void) | undefined;
		const first = admission.run(
			'a',
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				}),
		);

		await expect(admission.run('a', async () => {})).rejects.toThrow('key limit');
		const second = admission.run(
			'b',
			() =>
				new Promise<void>((resolve) => {
					finishSecond = resolve;
				}),
		);
		await expect(admission.run('c', async () => {})).rejects.toThrow('global limit');

		finishSecond?.();
		await second;
		await expect(admission.run('c', async () => 'ok')).resolves.toBe('ok');
		finishFirst?.();
		await first;
	});

	it('releases keyed admission after rejected work', async () => {
		const admission = new KeyedAdmission(1, 1, {
			global: () => new Error('global limit'),
			perKey: () => new Error('key limit'),
		});
		await expect(
			admission.run('a', async () => {
				throw new Error('work failed');
			}),
		).rejects.toThrow('work failed');
		expect(admission.activeCount).toBe(0);
		expect(admission.activeFor('a')).toBe(0);
		await expect(admission.run('a', async () => 'recovered')).resolves.toBe('recovered');
	});
});

describe('InFlightWork', () => {
	it('waits for tracked work before draining', async () => {
		const inFlight = new InFlightWork();
		let finish: (() => void) | undefined;
		const tracked = inFlight.track(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		let drained = false;
		const drain = inFlight.drain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		finish?.();
		await Promise.all([tracked, drain]);
		expect(drained).toBe(true);
	});

	it('waits for work tracked while an earlier drain snapshot is settling', async () => {
		const inFlight = new InFlightWork();
		let finishFirst: (() => void) | undefined;
		let finishSecond: (() => void) | undefined;
		const first = inFlight.track(
			new Promise<void>((resolve) => {
				finishFirst = resolve;
			}),
		);
		let drained = false;
		const drain = inFlight.drain().then(() => {
			drained = true;
		});
		const second = inFlight.track(
			new Promise<void>((resolve) => {
				finishSecond = resolve;
			}),
		);

		finishFirst?.();
		await first;
		await Promise.resolve();
		expect(drained).toBe(false);

		finishSecond?.();
		await Promise.all([second, drain]);
		expect(drained).toBe(true);
	});

	it('removes rejected work and lets drain settle', async () => {
		const inFlight = new InFlightWork();
		const tracked = inFlight.track(Promise.reject(new Error('delivery failed')));
		await expect(tracked).rejects.toThrow('delivery failed');
		await expect(inFlight.drain()).resolves.toBeUndefined();
	});
});
