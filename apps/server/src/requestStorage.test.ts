import { Hono } from 'hono';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { expect, it, vi } from 'vitest';
import { RequestStorage } from './requestStorage';

it('isolates concurrent request counts, including failed operations', async () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	try {
		const storage = new RequestStorage();
		const raw = new MemoryBucket();
		const bucket = storage.wrap(raw);
		vi.spyOn(raw, 'put').mockRejectedValueOnce(new Error('storage failed'));
		const app = new Hono().use('*', storage.middleware);
		app.get('/read', async (c) => {
			await bucket.get('secret/path');
			await bucket.head('key');
			return c.text('ok');
		});
		app.post('/write', async (c) => {
			await bucket.put('key', 'value');
			return c.text('ok');
		});
		const responses = await Promise.all([
			app.request('/read'),
			app.request('/write', { method: 'POST' }),
		]);
		expect(responses.map((r) => r.status)).toEqual([200, 500]);
		const events = log.mock.calls
			.map(
				([line]) =>
					JSON.parse(String(line)) as {
						event: string;
						route: string;
						storage_ops: Record<string, number>;
					},
			)
			.filter((event) => event.event === 'request');
		expect(events.find((e) => e.route === '/read')?.storage_ops).toEqual({
			get: 1,
			head: 1,
			list: 0,
			put: 0,
			delete: 0,
		});
		expect(events.find((e) => e.route === '/write')?.storage_ops).toEqual({
			get: 0,
			head: 0,
			list: 0,
			put: 1,
			delete: 0,
		});
		expect(JSON.stringify(events)).not.toContain('secret/path');
	} finally {
		log.mockRestore();
	}
});
