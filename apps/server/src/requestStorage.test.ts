import { Hono } from 'hono';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { configureLogLevel } from '@marimo-hub/core/logs';
import { afterEach, expect, it, vi } from 'vitest';
import { RequestStorage } from './requestStorage';

const emptyCounts = {
	get: 0,
	head: 0,
	list: 0,
	put: 0,
	delete: 0,
	putStream: 0,
	multipart_create: 0,
	multipart_putPart: 0,
	multipart_complete: 0,
	multipart_abort: 0,
};

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
			...emptyCounts,
			get: 1,
			head: 1,
		});
		expect(events.find((e) => e.route === '/write')?.storage_ops).toEqual({
			...emptyCounts,
			put: 1,
		});
		expect(JSON.stringify(events)).not.toContain('secret/path');
	} finally {
		log.mockRestore();
	}
});

it('counts streaming and multipart calls, including failures, without counting adapter internals', async () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	try {
		const raw = new MemoryBucket();
		Object.assign(raw, {
			async putStream(key: string, chunks: AsyncIterable<Uint8Array>, _size: number) {
				expect(this).toBe(raw);
				for await (const chunk of chunks) await raw.put(key, chunk);
				return (await raw.head(key))!;
			},
			multipart: {
				isolatedSessions: true as const,
				async create(_key: string) {
					expect(this.isolatedSessions).toBe(true);
					return { uploadId: 'upload' };
				},
				async putPart(_key: string, _uploadId: string, _part: number, _bytes: Uint8Array) {
					throw new Error('part failed');
				},
				async complete(key: string, _uploadId: string, _parts: unknown[]) {
					return raw.put(key, 'complete');
				},
				async abort(_key: string, _uploadId: string) {},
			},
		});
		const storage = new RequestStorage();
		const bucket = storage.wrap(raw);
		expect(bucket.multipart).toBe(bucket.multipart);
		expect(bucket.multipart!.putPart).toBe(bucket.multipart!.putPart);
		const app = new Hono().use('*', storage.middleware);
		app.post('/upload', async (c) => {
			await bucket.putStream!(
				'stream',
				(async function* () {
					yield new Uint8Array([1]);
				})(),
				1,
			);
			const { uploadId } = await bucket.multipart!.create('multipart');
			await expect(
				bucket.multipart!.putPart('multipart', uploadId, 1, new Uint8Array()),
			).rejects.toThrow('part failed');
			await bucket.multipart!.complete('multipart', uploadId, []);
			await bucket.multipart!.abort('multipart', uploadId);
			return c.text('ok');
		});
		expect((await app.request('/upload', { method: 'POST' })).status).toBe(200);
		const event = JSON.parse(String(log.mock.calls.at(-1)![0]));
		expect(event).toHaveProperty('storage_ops', {
			...emptyCounts,
			putStream: 1,
			multipart_create: 1,
			multipart_putPart: 1,
			multipart_complete: 1,
			multipart_abort: 1,
		});
		await bucket.put('outside-request', 'value');
		expect(log).toHaveBeenCalledTimes(1);
		expect(storage.wrap(new MemoryBucket()).multipart).toBeUndefined();
	} finally {
		log.mockRestore();
	}
});

afterEach(() => configureLogLevel(undefined));

it('logs API and storage-touching requests at info and other traffic at debug', async () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	try {
		const storage = new RequestStorage();
		const bucket = storage.wrap(new MemoryBucket());
		const app = new Hono().use('*', storage.middleware);
		app.get('/api/v1/health', (c) => c.text('ok'));
		app.get('/proxy/:id/*', (c) => c.text('kernel'));
		app.get('/_marimo/*', (c) => c.text('asset'));
		app.get('/share/:slug', async (c) => {
			await bucket.get('deep-link');
			return c.text('ok');
		});
		const requestLines = () =>
			log.mock.calls
				.map(
					([line]) => JSON.parse(String(line)) as { event: string; level: string; route: string },
				)
				.filter((event) => event.event === 'request');
		const paths = ['/api/v1/health', '/proxy/s1/assets/x.js', '/_marimo/0.1.0/a.js', '/share/x'];
		for (const path of paths) await app.request(path);
		expect(requestLines().map((event) => event.route)).toEqual(['/api/v1/health', '/share/:slug']);
		log.mockClear();
		configureLogLevel('debug');
		for (const path of paths) await app.request(path);
		expect(requestLines().map((event) => [event.route, event.level])).toEqual([
			['/api/v1/health', 'info'],
			['/proxy/:id/*', 'debug'],
			['/_marimo/*', 'debug'],
			['/share/:slug', 'info'],
		]);
	} finally {
		log.mockRestore();
	}
});
