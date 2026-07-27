import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import type { ApiDeps } from '@marimo-hub/api';
import { createServices, ProxyExposure, signProxyToken } from '@marimo-hub/core';
import type { Authenticator, ProjectId, UserId } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';

type UpgradeListener = (req: http.IncomingMessage, socket: PassThrough, head: Buffer) => void;

function fakeUpgradeServer() {
	const listeners: UpgradeListener[] = [];
	return { on: (_event: 'upgrade', l: UpgradeListener) => listeners.push(l), listeners };
}

function fakeIncomingMessage(url: string): http.IncomingMessage {
	return { url, headers: { host: 'hub.example.com' } } as unknown as http.IncomingMessage;
}

function authAs(userId: UserId | null): Authenticator {
	return {
		authenticate: async () => (userId ? { id: userId, email: `${userId}@example.com` } : null),
	};
}

/** Collect bytes written to a client socket, in flowing mode. */
function collect(socket: PassThrough): { text(): string } {
	const chunks: Buffer[] = [];
	socket.on('data', (chunk: Buffer) => chunks.push(chunk));
	return { text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('attachSandboxProxyUpgrade', () => {
	it('is a no-op when sandbox exposure is not proxy mode', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const server = fakeUpgradeServer();

		attachSandboxProxyUpgrade(server, deps);

		expect(server.listeners).toHaveLength(0);
	});

	it('leaves a non-proxy upgrade path alone (no write, no destroy)', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(SECRET),
			},
		});
		const server = fakeUpgradeServer();
		attachSandboxProxyUpgrade(server, deps);

		const socket = new PassThrough();
		const out = collect(socket);
		server.listeners[0](fakeIncomingMessage('/socket.io/?transport=ws'), socket, Buffer.alloc(0));

		await vi.waitFor(() => expect(out.text()).toBe('')); // give the async authorize a tick
		expect(socket.destroyed).toBe(false);
	});

	it('rejects an invalid token with an HTTP status line and destroys the socket', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(SECRET),
			},
		});
		const server = fakeUpgradeServer();
		attachSandboxProxyUpgrade(server, deps);

		const socket = new PassThrough();
		const out = collect(socket);
		server.listeners[0](fakeIncomingMessage('/proxy/not-a-real-token/'), socket, Buffer.alloc(0));

		await vi.waitFor(() => expect(socket.destroyed).toBe(true));
		expect(out.text()).toMatch(/^HTTP\/1\.1 403/);
	});

	describe('upstream relay', () => {
		let upstream: ReturnType<typeof createServer>;
		let upstreamOrigin: string;
		let lastUpstreamHeaders: http.IncomingHttpHeaders | undefined;

		beforeAll(async () => {
			upstream = createServer((req, res) => {
				lastUpstreamHeaders = req.headers;
				res.writeHead(404, 'Not Found');
				res.end();
			});
			await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
			upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
		});

		afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

		it('relays a non-upgrade upstream response and closes the client socket', async () => {
			const bucket = await createInitializedBucket();
			const services = createServices(bucket);
			const project = await services.projects.createProject(
				{ name: 'Owned', description: 'd' },
				ACTOR,
			);
			const pid = project.id as ProjectId;
			const notebook = await services.notebooks.createNotebook(
				pid,
				{ title: 'NB', description: 'd', code: 'import marimo as mo' },
				ACTOR,
			);
			const session = await services.sessions.createSession({
				notebook_id: notebook.id,
				project_id: pid,
				user_id: ACTOR,
			});
			await services.sessions.setRunning(
				pid,
				session.session_id,
				'/proxy/x/',
				false,
				upstreamOrigin,
			);
			const token = await signProxyToken(pid, session.session_id, SECRET);

			const deps: ApiDeps = makeTestDeps(bucket, {
				authenticator: authAs(ACTOR),
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					exposure: new ProxyExposure(SECRET),
				},
			});
			const server = fakeUpgradeServer();
			attachSandboxProxyUpgrade(server, deps);

			const socket = new PassThrough();
			const out = collect(socket);
			// Hub credentials ride the browser's upgrade request; the kernel (and the
			// notebook code that can read its request headers) must never see them.
			const req = fakeIncomingMessage(`/proxy/${token}/`);
			req.headers.cookie = 'hub_session=secret';
			req.headers.authorization = 'Bearer mhub_pat_secret';
			req.headers['cf-access-jwt-assertion'] = 'eyJhbGciOiJSUzI1NiJ9.access.jwt';
			req.headers['x-custom'] = 'passes';
			lastUpstreamHeaders = undefined;
			server.listeners[0](req, socket, Buffer.alloc(0));

			await vi.waitFor(() => expect(socket.destroyed).toBe(true));
			expect(out.text()).toMatch(/^HTTP\/1\.1 404/);
			expect(lastUpstreamHeaders).toBeDefined();
			expect(lastUpstreamHeaders!.cookie).toBeUndefined();
			expect(lastUpstreamHeaders!.authorization).toBeUndefined();
			expect(lastUpstreamHeaders!['cf-access-jwt-assertion']).toBeUndefined();
			expect(lastUpstreamHeaders!['x-custom']).toBe('passes');
		});

		it('strips Set-Cookie from a successful upgrade handshake', async () => {
			// The 101's headers are relayed verbatim, on the app's own origin — so a
			// kernel cookie would overwrite the caller's hub session.
			const upgrader = createServer();
			// An upgraded socket detaches from the server, so keep it to close by hand.
			let upstreamSocket: Duplex | undefined;
			upgrader.on('upgrade', (_req, socket) => {
				upstreamSocket = socket;
				socket.write(
					'HTTP/1.1 101 Switching Protocols\r\n' +
						'Upgrade: websocket\r\n' +
						'Connection: Upgrade\r\n' +
						'Set-Cookie: mh_session=attacker; Path=/\r\n\r\n',
				);
			});
			await new Promise<void>((resolve) => upgrader.listen(0, '127.0.0.1', resolve));
			const upgraderOrigin = `http://127.0.0.1:${(upgrader.address() as AddressInfo).port}`;

			try {
				const bucket = await createInitializedBucket();
				const services = createServices(bucket);
				const project = await services.projects.createProject(
					{ name: 'Owned', description: 'd' },
					ACTOR,
				);
				const pid = project.id as ProjectId;
				const notebook = await services.notebooks.createNotebook(
					pid,
					{ title: 'NB', description: 'd', code: 'import marimo as mo' },
					ACTOR,
				);
				const session = await services.sessions.createSession({
					notebook_id: notebook.id,
					project_id: pid,
					user_id: ACTOR,
				});
				await services.sessions.setRunning(
					pid,
					session.session_id,
					'/proxy/x/',
					false,
					upgraderOrigin,
				);
				const token = await signProxyToken(pid, session.session_id, SECRET);

				const deps: ApiDeps = makeTestDeps(bucket, {
					authenticator: authAs(ACTOR),
					sandbox: {
						bucket: { name: 'test', endpoint: '' },
						hostname: 'localhost',
						workdir: '/workspace',
						persistWorkspace: 'source',
						exposure: new ProxyExposure(SECRET),
					},
				});
				const server = fakeUpgradeServer();
				attachSandboxProxyUpgrade(server, deps);

				const socket = new PassThrough();
				const out = collect(socket);
				const req = fakeIncomingMessage(`/proxy/${token}/`);
				req.headers.connection = 'Upgrade';
				req.headers.upgrade = 'websocket';
				server.listeners[0](req, socket, Buffer.alloc(0));

				await vi.waitFor(() => expect(out.text()).toMatch(/^HTTP\/1\.1 101/));
				expect(out.text().toLowerCase()).not.toContain('set-cookie');
			} finally {
				upstreamSocket?.destroy();
				await new Promise<void>((resolve) => upgrader.close(() => resolve()));
			}
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});
});
