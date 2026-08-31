import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { createSandboxId, createServices } from '@marimo-hub/core';
import type { SandboxDuplexConnection, SandboxPortConnector } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { attachRemoteDevelopmentUpgrade } from './remoteDevelopmentWs';
import type { RemoteDevelopmentRelayOptions } from './remoteDevelopmentWs';

afterEach(() => vi.restoreAllMocks());

async function createRelayWorld(
	connectPort?: () => Promise<SandboxDuplexConnection>,
	options?: RemoteDevelopmentRelayOptions,
) {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'Owned', description: 'd' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: 'd', code: 'import marimo as mo' },
		ACTOR,
	);
	const session = await services.sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
		sandbox_image: 'remote-image',
		sandbox_brokered_ports: [2222],
		editor_sandbox_sharing: 'exclusive',
	});
	await services.sessions.setRunning(project.id, session.session_id, 'https://sandbox.invalid');

	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const close = vi.fn(async () => {});
	const base = makeTestDeps(bucket);
	const connector = vi.fn(
		connectPort ?? (async () => ({ readable: stream.readable, writable: stream.writable, close })),
	);
	const deps = makeTestDeps(bucket, {
		authenticator: { authenticate: async () => ({ id: ACTOR, email: 'actor@example.com' }) },
		compute: {
			...base.compute,
			capabilities: { multiPort: false, brokeredTcp: true },
			connectPort: connector,
		} as typeof base.compute & SandboxPortConnector,
		policy: { editorSandboxSharing: 'exclusive' },
		sandbox: {
			...base.sandbox,
			remoteDevelopment: { mode: 'ssh', images: ['remote-image'], port: 2222 },
		},
	});
	const server = createServer();
	attachRemoteDevelopmentUpgrade(server, deps, options);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	const url = `ws://127.0.0.1:${port}/api/v1/projects/${project.id}/notebooks/${notebook.id}/sessions/${session.session_id}/remote-development/ssh/relay`;
	return { close, connector, deps, notebook, project, server, services, session, stream, url };
}

async function openClient(url: string, token = 'test'): Promise<WebSocket> {
	const client = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
	await new Promise<void>((resolve, reject) => {
		client.once('open', resolve);
		client.once('error', reject);
	});
	return client;
}

async function expectUpgradeStatus(url: string, status: number, token?: string): Promise<void> {
	const headers = token === undefined ? undefined : { Authorization: `Bearer ${token}` };
	const client = new WebSocket(url, { headers });
	client.on('error', () => {});
	await new Promise<void>((resolve, reject) => {
		client.once('open', () => reject(new Error('upgrade unexpectedly succeeded')));
		client.once('unexpected-response', (_request, response) => {
			try {
				expect(response.statusCode).toBe(status);
				response.resume();
				resolve();
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('attachRemoteDevelopmentUpgrade', () => {
	it('relays binary frames in both directions and refreshes the development lease', async () => {
		const world = await createRelayWorld();
		const client = await openClient(world.url);
		const received = new Promise<Buffer>((resolve) =>
			client.once('message', (data) => resolve(Buffer.from(data as Buffer))),
		);
		client.send(Buffer.from([0, 1, 2, 255]));
		expect(await received).toEqual(Buffer.from([0, 1, 2, 255]));
		const updated = await world.services.sessions.getSession(
			world.project.id,
			world.session.session_id,
		);
		expect(Date.parse(updated.development_active_until!)).toBeGreaterThan(Date.now());

		client.close();
		await new Promise<void>((resolve) => client.once('close', () => resolve()));
		await vi.waitFor(() => expect(world.close).toHaveBeenCalled());
		await closeServer(world.server);
	});

	it('cleans up the relay when the initial development lease refresh fails', async () => {
		const world = await createRelayWorld();
		vi.spyOn(world.deps.services.sessions, 'heartbeatDevelopmentConnection').mockRejectedValue(
			new Error('storage unavailable'),
		);
		const client = new WebSocket(world.url, {
			headers: { Authorization: 'Bearer test' },
		});
		const opened = new Promise<void>((resolve, reject) => {
			client.once('open', resolve);
			client.once('error', reject);
		});
		const closed = new Promise<number>((resolve) => client.once('close', resolve));

		await opened;
		expect(await closed).toBe(1011);
		await vi.waitFor(() => expect(world.close).toHaveBeenCalledTimes(1));
		expect(world.stream.readable.locked).toBe(false);
		expect(world.stream.writable.locked).toBe(false);
		await closeServer(world.server);
	});

	it('rejects an upgrade without a bearer credential before opening the sandbox port', async () => {
		const world = await createRelayWorld();

		await expectUpgradeStatus(world.url, 401);

		expect(world.connector).not.toHaveBeenCalled();
		await closeServer(world.server);
	});

	it('returns bad gateway when the sandbox port cannot be reached', async () => {
		const world = await createRelayWorld(async () => {
			throw new Error('connection refused');
		});

		await expectUpgradeStatus(world.url, 502, 'test');

		expect(world.connector).toHaveBeenCalledTimes(1);
		await closeServer(world.server);
	});

	it('closes the upstream connection when the WebSocket handshake is malformed', async () => {
		const world = await createRelayWorld();
		const parsed = new URL(world.url);
		const socket = createConnection(Number(parsed.port), parsed.hostname);
		let response = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => (response += chunk));
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', resolve);
			socket.once('error', reject);
		});
		socket.write(
			[
				`GET ${parsed.pathname} HTTP/1.1`,
				`Host: ${parsed.host}`,
				'Authorization: Bearer test',
				'Connection: Upgrade',
				'Upgrade: websocket',
				'Sec-WebSocket-Version: 13',
				'Sec-WebSocket-Key: invalid',
				'',
				'',
			].join('\r\n'),
		);
		await new Promise<void>((resolve) => socket.once('close', () => resolve()));

		expect(response).toMatch(/^HTTP\/1\.1 400 /);
		await vi.waitFor(() => expect(world.close).toHaveBeenCalledTimes(1));
		await closeServer(world.server);
	});

	it('closes text-frame clients with unsupported-data status', async () => {
		const world = await createRelayWorld();
		const client = await openClient(world.url);
		const closed = new Promise<number>((resolve) => client.once('close', resolve));

		client.send('not ssh bytes');

		expect(await closed).toBe(1003);
		await closeServer(world.server);
	});

	it('limits concurrent relays per session', async () => {
		const world = await createRelayWorld(undefined, { maxConnectionsPerSession: 1 });
		const first = await openClient(world.url);

		await expectUpgradeStatus(world.url, 429, 'test');

		first.close();
		await new Promise<void>((resolve) => first.once('close', () => resolve()));
		await closeServer(world.server);
	});

	it('revokes an established relay after the session begins terminating', async () => {
		const world = await createRelayWorld(undefined, { reauthorizeMs: 10 });
		const client = await openClient(world.url);
		const closed = new Promise<number>((resolve) => client.once('close', resolve));

		await world.services.sessions.beginTerminating(world.project.id, world.session.session_id);

		expect(await closed).toBe(1008);
		await closeServer(world.server);
	});

	it('does not register an upgrade handler when SSH is disabled', () => {
		const deps = makeTestDeps(new MemoryBucket());
		const server = { on: vi.fn() };
		attachRemoteDevelopmentUpgrade(server, deps);
		expect(server.on).not.toHaveBeenCalled();
	});
});
