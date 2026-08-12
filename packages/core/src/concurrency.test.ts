import { describe, expect, it } from 'vitest';
import { InFlightWork, KeyedAdmission } from './concurrency';

describe('KeyedAdmission', () => {
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
});
