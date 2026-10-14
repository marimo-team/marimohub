import { once } from 'node:events';
import { createServer, get } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { createServices, ProxyExposure, signProxyToken } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { bootstrap } from './bootstrap';
import type { BootstrapHandle } from './bootstrap';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const JAVASCRIPT = 'console.log("kernel asset");\n'.repeat(200);

function rawRequest(url: string, encoding: string, method = 'GET') {
	return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
		(resolve, reject) => {
			get(url, { method, headers: { 'accept-encoding': encoding } }, (response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('error', reject);
				response.on('end', () =>
					resolve({
						status: response.statusCode!,
						headers: response.headers,
						body: Buffer.concat(chunks),
					}),
				);
			}).on('error', reject);
		},
	);
}

describe('Node proxy compression', () => {
	let upstream: Server;
	let handle: BootstrapHandle;
	let origin: string;
	let token: string;
	let eventStream: ServerResponse | undefined;
	let upstreamEncoding: string | undefined;
	let upstreamRequests = 0;

	function proxyUrl(path: string, route = 'proxy'): string {
		const prefix = route === 'proxy' ? `/proxy/${token}` : `/surface-proxy/${token}/vscode`;
		return `${origin}${prefix}${path}`;
	}

	beforeAll(async () => {
		upstream = createServer((request, response) => {
			upstreamEncoding = request.headers['accept-encoding'];
			upstreamRequests++;
			if (request.url?.endsWith('/disconnect')) {
				request.socket.destroy();
				return;
			}
			if (request.url?.endsWith('/encoded')) {
				const body = gzipSync(JAVASCRIPT);
				response.writeHead(200, {
					'content-type': 'text/javascript',
					'content-encoding': 'gzip',
					'content-length': body.length,
				});
				response.end(body);
				return;
			}
			if (request.url?.endsWith('/small')) {
				response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': 2 });
				response.end('ok');
				return;
			}
			if (request.url?.endsWith('/not-modified')) {
				response.writeHead(304, { 'content-type': 'text/javascript', etag: '"asset"' });
				response.end();
				return;
			}
			if (request.url?.endsWith('/truncated')) {
				response.writeHead(200, { 'content-type': 'text/javascript' });
				response.write(JAVASCRIPT, () => setTimeout(() => request.socket.destroy(), 20));
				return;
			}
			if (request.url?.endsWith('/empty')) {
				response.writeHead(204, { 'content-type': 'text/javascript' });
				response.end();
				return;
			}

			if (request.url?.endsWith('/echo')) {
				response.writeHead(200, { 'content-type': 'text/plain' });
				request.pipe(response);
				return;
			}
			if (request.url?.endsWith('/events')) {
				eventStream = response;
				response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
				response.write('data: first\n\n');
				return;
			}
			response.writeHead(
				request.url?.endsWith('/partial') ? 206 : request.url?.endsWith('/unavailable') ? 503 : 200,
				{
					'content-type': 'text/javascript',
					'content-length': Buffer.byteLength(JAVASCRIPT),
					...(request.url?.endsWith('/no-transform') ? { 'cache-control': 'no-transform' } : {}),
					...(request.url?.endsWith('/partial')
						? { 'content-range': `bytes 0-${JAVASCRIPT.length - 1}/${JAVASCRIPT.length * 2}` }
						: {}),
				},
			);
			response.end(JAVASCRIPT);
		});
		upstream.listen(0, '127.0.0.1');
		await once(upstream, 'listening');
		const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject(
			{ name: 'Proxy', description: '' },
			ACTOR,
		);
		const notebook = await services.notebooks.createNotebook(
			project.id,
			{
				title: 'Notebook',
				description: '',
				code: 'import marimo as mo',
			},
			ACTOR,
		);
		const session = await services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: ACTOR,
		});
		await services.sessions.setRunning(
			project.id,
			session.session_id,
			'/proxy/x/',
			false,
			upstreamOrigin,
		);
		await services.sessions.setSurfaceState(project.id, session.session_id, 'vscode', {
			status: 'ready',
			origin_url: upstreamOrigin,
			proxy_path: 'strip-prefix',
		});
		token = await signProxyToken(project.id, session.session_id, SECRET);
		const deps = makeTestDeps(bucket, {
			authenticator: {
				authenticate: async () => ({
					id: ACTOR,
					email: 'actor@example.com',
					credential: { kind: 'development' },
				}),
			},
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(SECRET),
			},
		});
		handle = (await bootstrap(
			{},
			{
				createDeps: () => deps,
				serveFn: (options, callback) => serve({ ...options, port: 0 }, callback),
				hostname: '127.0.0.1',
				startOtelFn: () => null,
				registerSignal: () => {},
			},
		))!;
		if (!handle.server.listening) await once(handle.server, 'listening');
		origin = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
	});

	afterEach(() => {
		eventStream?.end();
		eventStream = undefined;
		upstreamRequests = 0;
	});

	afterAll(async () => {
		await handle?.drain();
		upstream?.closeAllConnections();
		await new Promise<void>((resolve) => upstream?.close(() => resolve()));
	});

	it.each(['proxy', 'surface-proxy'])(
		'gzips large JavaScript on /%s while requesting identity upstream',
		async (route) => {
			const response = await rawRequest(proxyUrl('/assets/index.js', route), 'gzip');
			expect(response.status).toBe(200);
			expect(response.headers['content-encoding']).toBe('gzip');
			expect(response.headers['content-length']).toBeUndefined();
			expect(response.headers.vary).toMatch(/accept-encoding/i);
			expect(gunzipSync(response.body).toString()).toBe(JAVASCRIPT);
			expect(response.body.length).toBeLessThan(Buffer.byteLength(JAVASCRIPT));
			expect(upstreamEncoding).toBe('identity');
		},
	);

	it.each(['proxy', 'surface-proxy'])(
		'delivers the first /%s SSE chunk before the upstream closes',
		async (route) => {
			const response = await fetch(proxyUrl('/events', route), {
				headers: { 'accept-encoding': 'gzip' },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-encoding')).toBeNull();
			const reader = response.body!.getReader();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => reject(new Error('SSE first chunk was delayed')), 1000);
					}),
				]);
				expect(new TextDecoder().decode(chunk.value)).toBe('data: first\n\n');
				expect(chunk.done).toBe(false);
				expect(eventStream!.writableEnded).toBe(false);
				expect(upstreamEncoding).toBe('identity');
			} finally {
				clearTimeout(timeout);
				eventStream?.end();
				await reader.cancel();
			}
		},
	);

	it('preserves POST bodies through the Node wrapper', async () => {
		const response = await fetch(proxyUrl('/echo'), {
			method: 'POST',
			headers: { 'accept-encoding': 'gzip' },
			body: 'cell=42&value=updated',
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('cell=42&value=updated');
		expect(upstreamEncoding).toBe('identity');
	});

	it('honors a client declining compression', async () => {
		const response = await rawRequest(proxyUrl('/assets/index.js'), 'gzip;q=0, identity');
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.body.toString()).toBe(JAVASCRIPT);
		expect(upstreamEncoding).toBe('identity');
	});

	it.each(['no-transform', 'partial'])('preserves %s responses', async (path) => {
		const response = await rawRequest(proxyUrl(`/${path}`), 'gzip');
		expect(response.status).toBe(path === 'partial' ? 206 : 200);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.body.toString()).toBe(JAVASCRIPT);
	});

	it('handles an upstream that sends gzip despite the identity request without double encoding', async () => {
		const response = await rawRequest(proxyUrl('/encoded'), 'gzip');
		expect(response.status).toBe(200);
		expect(response.headers['content-encoding']).toBe('gzip');
		expect(response.headers['content-length']).toBeUndefined();
		expect(gunzipSync(response.body).toString()).toBe(JAVASCRIPT);
		expect(upstreamEncoding).toBe('identity');
	});

	it('leaves a body below the compression threshold unchanged', async () => {
		const response = await rawRequest(proxyUrl('/small'), 'gzip');
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.headers['content-length']).toBe('2');
		expect(response.body.toString()).toBe('ok');
	});

	it('preserves HEAD metadata without sending or compressing a body', async () => {
		const response = await rawRequest(proxyUrl('/assets/index.js'), 'gzip', 'HEAD');
		expect(response.status).toBe(200);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.headers['content-length']).toBe(String(Buffer.byteLength(JAVASCRIPT)));
		expect(response.body.length).toBe(0);
	});

	it('preserves an empty 204 response', async () => {
		const response = await rawRequest(proxyUrl('/empty'), 'gzip');
		expect(response.status).toBe(204);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.body.length).toBe(0);
	});

	it('preserves a 304 without a body or content encoding', async () => {
		const response = await rawRequest(proxyUrl('/not-modified'), 'gzip');
		expect(response.status).toBe(304);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.headers.etag).toBe('"asset"');
		expect(response.body.length).toBe(0);
	});

	it('closes the client response when the upstream fails mid-body while gzipping', async () => {
		const outcome = await new Promise<{ status: number; completed: boolean }>((resolve, reject) => {
			get(proxyUrl('/truncated'), { headers: { 'accept-encoding': 'gzip' } }, (response) => {
				let completed = false;
				response.resume();
				response.on('end', () => (completed = true));
				response.on('error', () => {});
				response.on('close', () => resolve({ status: response.statusCode!, completed }));
			}).on('error', reject);
		});
		expect(outcome).toEqual({ status: 200, completed: false });
		expect(handle.server.listening).toBe(true);
		const next = await rawRequest(proxyUrl('/assets/index.js'), 'gzip');
		expect(gunzipSync(next.body).toString()).toBe(JAVASCRIPT);
	});

	it('preserves upstream error status and body through compression without retrying', async () => {
		const response = await rawRequest(proxyUrl('/unavailable'), 'gzip');
		expect(response.status).toBe(503);
		expect(response.headers['content-encoding']).toBe('gzip');
		expect(gunzipSync(response.body).toString()).toBe(JAVASCRIPT);
		expect(upstreamRequests).toBe(1);
	});

	it('returns a gateway error after exhausting connection retries', async () => {
		const response = await fetch(proxyUrl('/disconnect'), {
			headers: { 'accept-encoding': 'gzip' },
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: 'SERVICE_UNAVAILABLE', message: 'Kernel unavailable' },
		});
		expect(upstreamRequests).toBe(2);
	});

	it('rejects an invalid token without contacting the upstream', async () => {
		const response = await fetch(`${origin}/proxy/invalid/assets/index.js`, {
			headers: { 'accept-encoding': 'gzip' },
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: 'FORBIDDEN', message: 'Invalid sandbox token' },
		});
		expect(upstreamRequests).toBe(0);
	});

	it('leaves non-proxy responses uncompressed', async () => {
		const response = await rawRequest(`${origin}/api/health`, 'gzip');
		expect(response.status).toBe(200);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.headers.vary).toBeUndefined();
	});
});
