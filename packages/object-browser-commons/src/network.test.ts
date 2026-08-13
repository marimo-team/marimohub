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

	// Node skips the pinned `lookup` for IP literals, so these would otherwise
	// reach link-local and loopback addresses unchecked.
	it.each([
		'http://169.254.169.254/latest/meta-data/',
		'http://127.0.0.1:9/',
		'http://[::1]:9/',
		'http://10.0.0.5/internal',
	])('rejects the IP-literal target %j through the host policy', async (url) => {
		let asked: string | undefined;
		const guardedFetch = createGuardedFetch(async (hostname) => {
			asked = hostname;
			throw new Error('The object-store hostname is not permitted.');
		});
		await expect(guardedFetch(url)).rejects.toThrow(/not permitted/);
		expect(asked).toBeDefined();
	});

	it('allows an IP literal the host policy permits', async () => {
		const server = createServer((_request, response) => response.end('ok'));
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const guardedFetch = createGuardedFetch(async (hostname) => [
				{ address: hostname, family: 4 },
			]);
			const response = await guardedFetch(`http://127.0.0.1:${port}/`);
			await expect(response.text()).resolves.toBe('ok');
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
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

	it('terminates a response whose socket stops making progress', async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/octet-stream' });
			response.write('partial');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const guardedFetch = createGuardedFetch(async () => [{ address: '127.0.0.1', family: 4 }], {
				socketTimeoutMs: 5,
			});
			const response = await guardedFetch(`http://objects.example.test:${port}/`);
			await expect(response.arrayBuffer()).rejects.toThrow(/timed out/);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
