import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServices, ProxyExposure, signProxyToken, SubdomainExposure } from '@marimo-hub/core';
import type { Authenticator, ProjectId, UserId } from '@marimo-hub/core';
import { ACTOR, makeFakeCompute, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createApi } from './createApi';
import { createInitializedBucket, makeTestDeps } from './testing';
import { authorizeProxyRequest, forwardHttp } from './sandboxProxy';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const STRANGER = uid('user_stranger');
const ORIGIN = 'http://kernel.internal:2718';

function authAs(userId: UserId | null): Authenticator {
	return {
		authenticate: async () => (userId ? { id: userId, email: `${userId}@example.com` } : null),
	};
}

describe('authorizeProxyRequest', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let sessionId: string;
	let token: string;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject(
			{ name: 'Owned', description: 'd' },
			ACTOR,
		);
		pid = project.id as ProjectId;
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
		sessionId = session.session_id;
		// Mark running with a server-reachable origin (proxy-mode provisioning).
		await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false, ORIGIN);
		token = await signProxyToken(pid, sessionId as never, SECRET);
	});

	function deps(userId: UserId | null) {
		return makeTestDeps(bucket, {
			authenticator: authAs(userId),
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(SECRET),
			},
		});
	}

	function req(path: string): Request {
		return new Request(`https://hub.example.com${path}`);
	}

	it('passes through non-proxy paths', async () => {
		const d = await authorizeProxyRequest(req('/api/me'), deps(ACTOR));
		expect(d.kind).toBe('pass');
	});

	it('passes through when proxy mode is not configured (no signing secret)', async () => {
		const d = await authorizeProxyRequest(
			req(`/proxy/${token}/`),
			makeTestDeps(bucket, {
				authenticator: authAs(ACTOR),
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					exposure: new SubdomainExposure(),
				},
			}),
		);
		expect(d.kind).toBe('pass');
	});

	it('rejects an invalid/forged token with 403', async () => {
		const d = await authorizeProxyRequest(req('/proxy/not-a-real-token/'), deps(ACTOR));
		expect(d).toMatchObject({ kind: 'reject', status: 403 });
	});

	it('rejects an unauthenticated request with 401', async () => {
		const d = await authorizeProxyRequest(req(`/proxy/${token}/`), deps(null));
		expect(d).toMatchObject({ kind: 'reject', status: 401 });
	});

	it('rejects a caller without project access with 403', async () => {
		const d = await authorizeProxyRequest(req(`/proxy/${token}/`), deps(STRANGER));
		expect(d).toMatchObject({ kind: 'reject', status: 403 });
	});

	it('forwards a non-member super admin to the kernel', async () => {
		const d = await authorizeProxyRequest(req(`/proxy/${token}/`), {
			...deps(STRANGER),
			policy: { superAdmins: [STRANGER] },
		});
		expect(d.kind).toBe('forward');
	});

	it('rejects a non-owner editor from an exclusive editor kernel', async () => {
		const services = createServices(bucket);
		const notebooks = await services.notebooks.listNotebooks(pid);
		const exclusive = await services.sessions.createSession({
			notebook_id: notebooks[0].id,
			project_id: pid,
			user_id: ACTOR,
			mode: 'edit',
			editor_sandbox_sharing: 'exclusive',
		});
		await services.sessions.setRunning(pid, exclusive.session_id, '/proxy/x/', false, ORIGIN);
		const exclusiveToken = await signProxyToken(pid, exclusive.session_id, SECRET);

		const d = await authorizeProxyRequest(req(`/proxy/${exclusiveToken}/`), {
			...deps(STRANGER),
			policy: { defaultRole: 'editor' },
		});
		expect(d).toMatchObject({ kind: 'reject', status: 403 });
	});

	describe('viewer access to the shared app kernel', () => {
		let appToken: string;

		beforeEach(async () => {
			const services = createServices(bucket);
			const notebooks = await services.notebooks.listNotebooks(pid);
			const session = await services.sessions.createSession({
				notebook_id: notebooks[0].id,
				project_id: pid,
				user_id: ACTOR,
				mode: 'app',
			});
			await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false, ORIGIN);
			appToken = await signProxyToken(pid, session.session_id as never, SECRET);
		});

		const viewerDeps = (viewerMode?: 'static' | 'applications' | 'ephemeral-sandbox') => ({
			...deps(STRANGER),
			policy: { defaultRole: 'viewer' as const, ...(viewerMode ? { viewerMode } : {}) },
		});

		it('forwards a viewer to the app kernel under `applications` and `ephemeral-sandbox`', async () => {
			for (const mode of ['applications', 'ephemeral-sandbox'] as const) {
				const d = await authorizeProxyRequest(req(`/proxy/${appToken}/`), viewerDeps(mode));
				expect(d.kind).toBe('forward');
			}
		});

		it('rejects a viewer from the app kernel under `static` (and when unset)', async () => {
			for (const dep of [viewerDeps('static'), viewerDeps()]) {
				const d = await authorizeProxyRequest(req(`/proxy/${appToken}/`), dep);
				expect(d).toMatchObject({ kind: 'reject', status: 403 });
			}
		});

		it('never admits a viewer to another user’s EDIT kernel, whatever the viewer mode', async () => {
			const d = await authorizeProxyRequest(
				req(`/proxy/${token}/`),
				viewerDeps('ephemeral-sandbox'),
			);
			expect(d).toMatchObject({ kind: 'reject', status: 403 });
		});

		it('members-only deployment: a non-member gains nothing from `applications`', async () => {
			const d = await authorizeProxyRequest(req(`/proxy/${appToken}/`), {
				...deps(STRANGER),
				policy: { viewerMode: 'applications' as const },
			});
			expect(d).toMatchObject({ kind: 'reject', status: 403 });
		});
	});

	it('forwards an authorized request to the kernel origin, preserving the full path', async () => {
		const d = await authorizeProxyRequest(req(`/proxy/${token}/assets/app.js?v=1`), deps(ACTOR));
		expect(d).toMatchObject({
			kind: 'forward',
			targetUrl: `${ORIGIN}/proxy/${token}/assets/app.js?v=1`,
			sessionId,
		});
	});

	it('rejects a terminated session with 410', async () => {
		await createServices(bucket).sessions.terminate(pid, sessionId as never);
		const d = await authorizeProxyRequest(req(`/proxy/${token}/`), deps(ACTOR));
		expect(d).toMatchObject({ kind: 'reject', status: 410 });
	});

	it('rejects a session whose project was soft-deleted', async () => {
		// Deleting a project must cut kernel access immediately — the sandbox may
		// still be alive, and in proxy mode this is the only gate in its path.
		await createServices(bucket).projects.deleteProject(pid, ACTOR);
		const d = await authorizeProxyRequest(req(`/proxy/${token}/`), deps(ACTOR));
		expect(d.kind).not.toBe('forward');
	});

	it('rejects 404 when the token references a session that does not exist', async () => {
		// A validly-signed token for a session id that was never created.
		const ghost = 'sess-0000000000000000';
		const ghostToken = await signProxyToken(pid, ghost as never, SECRET);
		const d = await authorizeProxyRequest(req(`/proxy/${ghostToken}/`), deps(ACTOR));
		expect(d).toMatchObject({ kind: 'reject', status: 404 });
	});

	it('rejects 503 when a running session has no sandbox_origin_url', async () => {
		// A running session provisioned under a different exposure mode records no
		// origin — it is authorized but not reachable via the proxy.
		const services = createServices(bucket);
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB2', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const session = await services.sessions.createSession({
			notebook_id: notebook.id,
			project_id: pid,
			user_id: ACTOR,
		});
		// setRunning WITHOUT an origin url (5th arg omitted).
		await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false);
		const noOriginToken = await signProxyToken(pid, session.session_id as never, SECRET);

		const d = await authorizeProxyRequest(req(`/proxy/${noOriginToken}/`), deps(ACTOR));
		expect(d).toMatchObject({ kind: 'reject', status: 503 });
	});
});

describe('forwardHttp', () => {
	let server: Server;
	let origin: string;

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === '/setcookie') {
				res.writeHead(200, {
					'set-cookie': 'mh_session=attacker; Path=/',
					'content-type': 'text/plain',
				});
				res.end('ok');
				return;
			}
			if (req.url === '/gzip') {
				const body = gzipSync('hello '.repeat(20));
				res.writeHead(200, {
					'content-encoding': 'gzip',
					'content-length': String(body.length),
					'content-type': 'text/plain',
				});
				res.end(body);
				return;
			}
			// Echo the request headers the kernel actually received.
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(req.headers));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it('decodes a gzipped kernel response without leaving a stale content-encoding', async () => {
		const res = await forwardHttp(new Request('https://hub/x'), `${origin}/gzip`);
		// The body must be readable (not a double-decode failure), and the dropped
		// content-encoding/length must not mislead the browser.
		expect(await res.text()).toBe('hello '.repeat(20));
		expect(res.headers.get('content-encoding')).toBeNull();
		expect(res.headers.get('content-length')).toBeNull();
	});

	it('rewrites Origin to the kernel so marimo reads the request as same-origin', async () => {
		const req = new Request('https://hub.example.com/proxy/tok/api', {
			headers: { origin: 'https://hub.example.com' },
		});
		const res = await forwardHttp(req, `${origin}/echo`);
		const seen = (await res.json()) as Record<string, string>;
		expect(seen.origin).toBe(origin);
	});

	it('returns 502 when the kernel is unreachable', async () => {
		const res = await forwardHttp(new Request('https://hub/x'), 'http://127.0.0.1:1/down');
		expect(res.status).toBe(502);
	});

	it('strips hub credentials (Cookie/Authorization/CF-Access) before the kernel sees the request', async () => {
		// Notebook code can read request headers (mo.app_meta().request) — the
		// caller's hub session cookie / PAT / Access assertion must never reach it.
		const req = new Request('https://hub.example.com/proxy/tok/api', {
			headers: {
				cookie: 'hub_session=secret',
				authorization: 'Bearer mhub_pat_secret',
				'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.access.jwt',
				'cf-access-client-id': 'svc.access',
				'cf-access-client-secret': 'svc-secret',
				'x-custom': 'passes',
			},
		});
		const res = await forwardHttp(req, `${origin}/echo`);
		const seen = (await res.json()) as Record<string, string>;
		expect(seen.cookie).toBeUndefined();
		expect(seen.authorization).toBeUndefined();
		expect(seen['cf-access-jwt-assertion']).toBeUndefined();
		expect(seen['cf-access-client-id']).toBeUndefined();
		expect(seen['cf-access-client-secret']).toBeUndefined();
		expect(seen['x-custom']).toBe('passes');
	});

	it('strips Set-Cookie from the kernel response', async () => {
		// In proxy mode a kernel cookie is written for the hub's own origin, so a
		// notebook could overwrite the caller's hub session.
		const res = await forwardHttp(new Request('https://hub/x'), `${origin}/setcookie`);
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(await res.text()).toBe('ok');
	});
});

describe('create-session in proxy mode', () => {
	it('returns a /proxy/<token>/ client URL and persists the origin off-response', async () => {
		const bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
		const pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);

		const deps = makeTestDeps(bucket, {
			authenticator: authAs(ACTOR),
			compute: makeFakeCompute(),
			sandbox: {
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(SECRET),
				appBaseUrl: 'https://hub.example.com',
			},
		});
		const app = createApi(deps);

		const res = await app.request(`/api/v1/projects/${pid}/notebooks/${notebook.id}/sessions`, {
			method: 'POST',
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { session_id: string; sandbox_url: string } };

		const token = await signProxyToken(pid, data.session_id as never, SECRET);
		expect(data.sandbox_url).toBe(`https://hub.example.com/proxy/${token}/`);
		// The server-reachable origin is persisted on the record but never in the response.
		expect(data).not.toHaveProperty('sandbox_origin_url');
		const stored = await services.sessions.getSession(pid, data.session_id as never);
		expect(stored.sandbox_origin_url).toBe('https://sandbox.example/kernel');
	});
});
