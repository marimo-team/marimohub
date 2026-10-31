import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createInitializedBucket, createTestApi, expectOk } from '@marimo-hub/api/testing';
import { createServices, paths, ProxyExposure } from '@marimo-hub/core';
import type { AppVisit, SessionId } from '@marimo-hub/core';
import { ACTOR, makeFakeCompute } from '@marimo-hub/core/testing';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

it.each(['', '/marimohub'])('preserves routing and lease limits under %s', async (prefix) => {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'Proxy', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'App', description: '', code: '' },
		ACTOR,
	);
	const api = createTestApi({
		bucket,
		compute: makeFakeCompute(),
		deps: {
			sandbox: {
				appBaseUrl: `https://hub.example${prefix}`,
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure('local-combined-proxy-test-secret'),
			},
		},
	});
	const admission = await expectOk(
		await api.request('POST', `/projects/${project.id}/notebooks/${notebook.id}/sessions`, {
			mode: 'app',
			app_visit_id: 'frame',
		}),
	);
	const sid = admission.session_id as SessionId;
	const visit = admission.app_assignment as AppVisit;
	const key = paths.session(project.id, sid);
	const upgrader = createServer();
	let upstream: Duplex | undefined;
	let seen: http.IncomingHttpHeaders | undefined;
	let seenPath: string | undefined;
	upgrader.on('upgrade', (req, socket) => {
		seen = req.headers;
		seenPath = req.url;
		upstream = socket;
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-marimohub-app-proxy: forged\r\nx-marimohub-app-generation: secret\r\n\r\n',
		);
	});
	await new Promise<void>((resolve) => upgrader.listen(0, '127.0.0.1', resolve));
	const client = new PassThrough();
	const output: Buffer[] = [];
	client.on('data', (chunk: Buffer) => output.push(chunk));
	const patch = async (changes: Record<string, unknown>) => {
		const object = (await bucket.get(key))!;
		await bucket.put(
			key,
			JSON.stringify({ ...(await object.json<Record<string, unknown>>()), ...changes }),
			{
				onlyIfEtagMatches: object.etag,
			},
		);
	};
	try {
		await patch({
			sandbox_origin_url: `http://127.0.0.1:${(upgrader.address() as AddressInfo).port}`,
			last_heartbeat: new Date(Date.now() - 61_000).toISOString(),
		});
		const heartbeat = api.deps.services.sessions.heartbeat.bind(api.deps.services.sessions);
		vi.spyOn(api.deps.services.sessions, 'heartbeat').mockImplementation(async (pid, id) => {
			await patch({ authorization_expires_at: new Date(Date.now() + 1500).toISOString() });
			return heartbeat(pid, id);
		});
		let upgrade!: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
		attachSandboxProxyUpgrade(
			{
				on: (_event, listener) => {
					upgrade = listener;
				},
			},
			api.deps,
		);
		const request = {
			url: `/app-proxy/${project.id}/${notebook.id}/${sid}/ws`,
			headers: {
				host: 'hub.example',
				connection: 'Upgrade',
				upgrade: 'websocket',
				'x-marimohub-app-visit-id': visit.visit_id,
				'x-marimohub-app-generation': visit.generation,
				'x-marimohub-app-proxy': 'forged',
				'x-marimohub-app-status': 'starting',
			},
		} as unknown as http.IncomingMessage;
		upgrade(request, client, Buffer.alloc(0));
		await vi.waitFor(() =>
			expect(Buffer.concat(output).toString()).toContain('101 Switching Protocols'),
		);
		expect(seen).toBeDefined();
		const session = await api.deps.services.sessions.getSession(project.id, sid);
		expect(seenPath).toBe(`${new URL(session.sandbox_url!).pathname}ws`);
		expect(Object.keys(seen!).filter((name) => name.startsWith('x-marimohub-app-'))).toEqual([]);
		const response = Buffer.concat(output).toString();
		expect(response).toContain('x-marimohub-app-proxy: 1\r\n');
		expect(response).not.toContain('forged');
		expect(response).not.toContain('secret');
		await vi.waitFor(() => expect(client.destroyed).toBe(true), { timeout: 4000 });
	} finally {
		vi.restoreAllMocks();
		client.destroy();
		upstream?.destroy();
		await new Promise<void>((resolve) => upgrader.close(() => resolve()));
	}
});
