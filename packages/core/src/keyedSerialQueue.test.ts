import { describe, expect, it, vi } from 'vitest';
import { KeyedSerialQueue } from './concurrency';

describe('KeyedSerialQueue', () => {
	it('runs same-key tasks in FIFO order and different keys concurrently', async () => {
		const queue = new KeyedSerialQueue<string>();
		const gate = Promise.withResolvers<void>();
		const events: string[] = [];
		const first = queue.run('a', async () => {
			events.push('a1');
			await gate.promise;
			events.push('a1 done');
		});
		const second = queue.run('a', async () => {
			events.push('a2');
			return 42;
		});
		await queue.run('b', async () => {
			events.push('b');
		});
		expect(events).toEqual(['a1', 'b']);
		gate.resolve();
		await first;
		await expect(second).resolves.toBe(42);
		expect(events).toEqual(['a1', 'b', 'a1 done', 'a2']);
	});

	it('recovers from asynchronous and synchronous failures', async () => {
		const queue = new KeyedSerialQueue<string>();
		const first = queue.run('a', async () => {
			throw new Error('async');
		});
		const second = queue.run('a', () => {
			throw new Error('sync');
		});
		const third = queue.run('a', async () => 'ok');
		await expect(first).rejects.toThrow('async');
		await expect(second).rejects.toThrow('sync');
		await expect(third).resolves.toBe('ok');
	});

	it('does not remove a newer tail when an earlier task settles and cleans idle keys', async () => {
		const queue = new KeyedSerialQueue<string>();
		const gate = Promise.withResolvers<void>();
		const first = queue.run('a', async () => {});
		const second = queue.run('a', () => gate.promise);
		await first;
		const run = vi.fn(async () => {});
		const third = queue.run('a', run);
		await queue.run('b', async () => {});
		expect(run).not.toHaveBeenCalled();
		gate.resolve();
		await Promise.all([second, third]);
		// Idle keys must not retain resource identifiers for the lifetime of a service.
		// oxlint-disable-next-line typescript/dot-notation -- inspect private storage without widening the public API
		expect(queue['tails'].size).toBe(0);
	});
});
