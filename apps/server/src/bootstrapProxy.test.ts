import { once } from 'node:events';
import { createServer, get } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { createServices, ProxyExposure, signProxyToken } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { bootstrap } from './bootstrap';
import type { BootstrapHandle } from './bootstrap';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const JAVASCRIPT = 'console.log("kernel asset");\n'.repeat(200);

function rawGet(url: string, encoding: string) {
	return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
		(resolve, reject) => {
			get(url, { headers: { 'accept-encoding': encoding } }, (response) => {
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

	beforeAll(async () => {
		upstream = createServer((request, response) => {
			upstreamEncoding = request.headers['accept-encoding'];
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
			response.writeHead(request.url?.endsWith('/partial') ? 206 : 200, {
				'content-type': 'text/javascript',
				'content-length': Buffer.byteLength(JAVASCRIPT),
				...(request.url?.endsWith('/no-transform') ? { 'cache-control': 'no-transform' } : {}),
				...(request.url?.endsWith('/partial')
					? { 'content-range': `bytes 0-${JAVASCRIPT.length - 1}/${JAVASCRIPT.length * 2}` }
					: {}),
			});
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
	});

	afterAll(async () => {
		await handle?.drain();
		upstream?.closeAllConnections();
		await new Promise<void>((resolve) => upstream?.close(() => resolve()));
	});

	it.each(['proxy', 'surface-proxy'])(
		'gzips large JavaScript on /%s while requesting identity upstream',
		async (route) => {
			const path = route === 'proxy' ? `/proxy/${token}` : `/surface-proxy/${token}/vscode`;
			const response = await rawGet(`${origin}${path}/assets/index.js`, 'gzip');
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
			const path = route === 'proxy' ? `/proxy/${token}` : `/surface-proxy/${token}/vscode`;
			const response = await fetch(`${origin}${path}/events`, {
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
		const response = await fetch(`${origin}/proxy/${token}/echo`, {
			method: 'POST',
			headers: { 'accept-encoding': 'gzip' },
			body: 'cell=42&value=updated',
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('cell=42&value=updated');
		expect(upstreamEncoding).toBe('identity');
	});

	it('honors a client declining compression', async () => {
		const response = await rawGet(`${origin}/proxy/${token}/assets/index.js`, 'gzip;q=0, identity');
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.body.toString()).toBe(JAVASCRIPT);
		expect(upstreamEncoding).toBe('identity');
	});

	it.each(['no-transform', 'partial'])('preserves %s responses', async (path) => {
		const response = await rawGet(`${origin}/proxy/${token}/${path}`, 'gzip');
		expect(response.status).toBe(path === 'partial' ? 206 : 200);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.body.toString()).toBe(JAVASCRIPT);
	});

	it('leaves non-proxy responses uncompressed', async () => {
		const response = await rawGet(`${origin}/api/health`, 'gzip');
		expect(response.status).toBe(200);
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.headers.vary).toBeUndefined();
	});
});
