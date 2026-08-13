import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createGuardedFetch } from './network';

describe('guarded fetch', () => {
	it('preserves method, headers, and body from Request inputs', async () => {
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						method: request.method,
						header: request.headers['x-object-test'],
						body: Buffer.concat(chunks).toString('utf8'),
					}),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const guardedFetch = createGuardedFetch(async () => [{ address: '127.0.0.1', family: 4 }]);
			const response = await guardedFetch(
				new Request(`http://objects.example.test:${port}/`, {
					method: 'POST',
					headers: { 'X-Object-Test': 'preserved' },
					body: 'request-body',
				}),
			);
			await expect(response.json()).resolves.toEqual({
				method: 'POST',
				header: 'preserved',
				body: 'request-body',
			});
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it('preserves AbortError from a canceled DNS resolution', async () => {
		const guardedFetch = createGuardedFetch(async () => {
			throw new DOMException('canceled', 'AbortError');
		});
		await expect(guardedFetch('http://objects.example.test/')).rejects.toMatchObject({
			name: 'AbortError',
		});
	});

	it('propagates a Request signal to the guarded transport', async () => {
		const controller = new AbortController();
		const guardedFetch = createGuardedFetch(
			async (_hostname, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener('abort', () =>
						reject(new DOMException('canceled', 'AbortError')),
					);
				}),
		);
		const pending = guardedFetch(
			new Request('http://objects.example.test/', { signal: controller.signal }),
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});
