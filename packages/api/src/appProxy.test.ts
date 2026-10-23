import { afterEach, expect, it, vi } from 'vitest';
import {
	AppPoolService,
	createServices,
	paths,
	ProxyExposure,
	signProxyToken,
} from '@marimo-hub/core';
import type { AppVisit, SessionId } from '@marimo-hub/core';
import {
	ACTOR,
	localResourceSecurity,
	makeFakeCompute,
	makeSubjectContext,
	uid,
} from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk } from './testing';
import {
	APP_GENERATION_HEADER,
	APP_PROXY_HEADER,
	APP_STATUS_HEADER,
	APP_VISIT_HEADER,
	authorizeProxyRequest,
	isCredentialHeader,
} from './sandboxProxy';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function fixture(appBaseUrl?: string) {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject(
		{ name: 'App proxy', description: '' },
		ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'App', description: '', code: 'import marimo' },
		ACTOR,
	);
	const secret = 'local-app-proxy-contract-signing-secret';
	const api = createTestApi({
		bucket,
		compute: makeFakeCompute(),
		deps: {
			sandbox: {
				appBaseUrl,
				bucket: { name: 'test', endpoint: '' },
				hostname: 'localhost',
				workdir: '/workspace',
				persistWorkspace: 'source',
				exposure: new ProxyExposure(secret),
			},
		},
	});
	const sessions = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	const admitted = await expectOk(
		await api.request('POST', sessions, { mode: 'app', app_visit_id: 'one' }),
	);
	const sessionId = admitted.session_id as SessionId;
	const assignment = admitted.app_assignment as AppVisit;
	const path = `/app-proxy/${project.id}/${notebook.id}/${sessionId}`;
	const request = (visit = assignment, suffix = '/api/kernel/set_ui_element_value') =>
		new Request(`http://hub${path}${suffix}`, {
			headers: { [APP_VISIT_HEADER]: visit.visit_id, [APP_GENERATION_HEADER]: visit.generation },
		});
	async function patch(key: string, changes: Record<string, unknown>) {
		const object = (await bucket.get(key))!;
		await bucket.put(
			key,
			JSON.stringify({ ...(await object.json<Record<string, unknown>>()), ...changes }),
			{
				onlyIfEtagMatches: object.etag,
			},
		);
	}
	return {
		api,
		bucket,
		project,
		notebook,
		sessionId,
		assignment,
		sessions,
		path,
		request,
		patch,
		secret,
	};
}

it('advertises the contract and forwards the exact app with four fresh metadata reads', async () => {
	const f = await fixture();
	expect(await expectOk(await f.api.request('GET', '/capabilities'))).toMatchObject({
		app_pool: { proxy_renewal: true },
	});
	const get = vi.spyOn(f.bucket, 'get');
	const head = vi.spyOn(f.bucket, 'head');
	const put = vi.spyOn(f.bucket, 'put');
	const decision = await authorizeProxyRequest(f.request(f.assignment, '/health?x=1'), f.api.deps);
	expect(decision).toMatchObject({ kind: 'forward', sessionId: f.sessionId });
	if (decision.kind !== 'forward') throw new Error('Unexpected rejection');
	expect(new URL(decision.targetUrl).pathname).toContain(
		`/proxy/${await signProxyToken(f.project.id, f.sessionId, f.secret)}/health`,
	);
	expect(new URL(decision.targetUrl).search).toBe('?x=1');
	expect([...get.mock.calls, ...head.mock.calls].map(([key]) => key)).toEqual(
		expect.arrayContaining([
			paths.session(f.project.id, f.sessionId),
			paths.project(f.project.id).meta,
			paths.project(f.project.id).notebook(f.notebook.id).meta,
			paths.appPool(f.project.id, f.notebook.id),
		]),
	);
	expect(get.mock.calls.length + head.mock.calls.length).toBe(4);
	expect(put).not.toHaveBeenCalled();
	expect(isCredentialHeader(APP_VISIT_HEADER)).toBe(true);
	expect(isCredentialHeader(APP_GENERATION_HEADER)).toBe(true);
});

it('forwards HTTP to the persisted kernel prefix even if the public base changes', async () => {
	const f = await fixture('https://hub.example/marimohub');
	f.api.deps.sandbox.appBaseUrl = 'https://hub.example/moved';
	const token = await signProxyToken(f.project.id, f.sessionId, f.secret);
	const session = await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId);
	expect(session.sandbox_url).toBe(`https://hub.example/marimohub/proxy/${token}/`);
	const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('kernel'));
	const response = await f.api.app.fetch(f.request(f.assignment, '/health?x=1'));
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('kernel');
	expect(response.headers.get(APP_PROXY_HEADER)).toBe('1');
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][0]).toBe(
		`${session.sandbox_origin_url}/marimohub/proxy/${token}/health?x=1`,
	);
});

it('retains the signed route fallback for sessions without a persisted sandbox URL', async () => {
	const f = await fixture();
	await f.patch(paths.session(f.project.id, f.sessionId), { sandbox_url: undefined });
	const token = await signProxyToken(f.project.id, f.sessionId, f.secret);
	const decision = await authorizeProxyRequest(f.request(f.assignment, '/health?x=1'), f.api.deps);
	if (decision.kind !== 'forward') throw new Error('Expected forward');
	const session = await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId);
	expect(decision.targetUrl).toBe(`${session.sandbox_origin_url}/proxy/${token}/health?x=1`);
});

it('reports starting only after authorizing and renewing the exact app visit', async () => {
	const f = await fixture();
	await f.patch(paths.session(f.project.id, f.sessionId), {
		status: 'starting',
		sandbox_origin_url: undefined,
	});
	const response = await f.api.app.fetch(f.request());
	expect(response.status).toBe(503);
	expect(response.headers.get(APP_PROXY_HEADER)).toBe('1');
	expect(response.headers.get(APP_STATUS_HEADER)).toBe('starting');
	const wrong = await f.api.app.fetch(f.request({ ...f.assignment, generation: 'wrong' }));
	expect(wrong.status).toBe(410);
	expect(wrong.headers.get(APP_STATUS_HEADER)).toBeNull();
	await f.patch(paths.project(f.project.id).meta, {
		owner: uid('other'),
		members: [],
		default_role: 'none',
	});
	const revoked = await f.api.app.fetch(f.request());
	expect(revoked.status).toBe(403);
	expect(revoked.headers.get(APP_STATUS_HEADER)).toBeNull();
});

it.each(
	[
		{ name: 'root', appBaseUrl: undefined, publicBase: 'http://hub', headers: {} },
		{
			name: 'forwarded HTTPS',
			appBaseUrl: undefined,
			publicBase: 'https://hub.example',
			headers: { host: 'hub.example', 'x-forwarded-proto': 'https, http' },
		},
		{
			name: 'prefixed HTTPS',
			appBaseUrl: 'https://hub.example/marimohub/',
			publicBase: 'https://hub.example/marimohub',
			headers: { host: 'api.internal', 'x-forwarded-proto': 'http' },
		},
	].flatMap((deployment) =>
		['absolute', 'root-relative', 'relative', 'query', 'outside', 'other-session'].map((shape) => ({
			...deployment,
			shape,
		})),
	),
)(
	'handles $shape kernel redirects with $name deployment',
	async ({ shape, appBaseUrl, publicBase, headers }) => {
		const f = await fixture(appBaseUrl);
		const request = f.request(f.assignment, '/nested/page');
		for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
		const decision = await authorizeProxyRequest(request, f.api.deps);
		if (decision.kind !== 'forward') throw new Error('Expected forward');
		const kernel = new URL(decision.targetUrl);
		const base = new URL(decision.appProxyBaseUrl!).pathname;
		const location = {
			absolute: `${kernel.origin}${base}/nested/next?x=1#part`,
			'root-relative': `${base}/nested/next?x=1#part`,
			relative: 'next?x=1#part',
			query: '?x=1#part',
			outside: 'https://other.invalid/notebook',
			'other-session': `${base}-other/notebook`,
		}[shape]!;
		const fetch = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 307, headers: { location } }));
		const response = await f.api.app.fetch(request);
		expect(response.headers.get(APP_PROXY_HEADER)).toBe('1');
		if (shape === 'outside' || shape === 'other-session') {
			expect(response.status).toBe(502);
			expect(response.headers.get('location')).toBeNull();
		} else {
			expect(response.status).toBe(307);
			expect(response.headers.get('location')).toBe(
				`${publicBase}${f.path}/nested/${shape === 'query' ? 'page' : 'next'}?x=1#part`,
			);
		}
		expect(fetch).toHaveBeenCalledTimes(1);
	},
);

it.each([
	'missing',
	'wrong-visit',
	'wrong-generation',
	'wrong-notebook',
	'left',
	'expired',
	'terminal',
	'revoked',
	'deleted',
	'labels',
	'suspended',
	'no-auth',
	'proxy-only',
	'attach-only',
	'wrong-project-grant',
	'wrong-user',
	'non-app',
	'legacy-app',
	'authorization-expired',
])('rejects %s without renewal', async (kind) => {
	const f = await fixture();
	let request = f.request();
	if (kind === 'missing') request = new Request(`http://hub${f.path}/health`);
	if (kind === 'wrong-visit') request = f.request({ ...f.assignment, visit_id: 'other' });
	if (kind === 'wrong-generation') request = f.request({ ...f.assignment, generation: 'stale' });
	if (kind === 'wrong-notebook') {
		const other = await f.api.deps.services.notebooks.createNotebook(
			f.project.id,
			{ title: 'Other', description: '', code: '' },
			ACTOR,
		);
		request = new Request(request.url.replace(f.notebook.id, other.id), request);
	}
	if (kind === 'left')
		await expectOk(await f.api.request('POST', `${f.sessions}/${f.sessionId}/leave`, f.assignment));
	if (kind === 'expired') {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 180_000);
	}
	if (kind === 'terminal')
		await f.api.deps.services.sessions.markTerminated(f.project.id, f.sessionId);
	if (kind === 'non-app') await f.patch(paths.session(f.project.id, f.sessionId), { mode: 'edit' });
	if (kind === 'legacy-app')
		await f.patch(paths.session(f.project.id, f.sessionId), { app_pool: undefined });
	if (kind === 'authorization-expired')
		await f.patch(paths.session(f.project.id, f.sessionId), {
			authorization_expires_at: new Date(Date.now() - 1000).toISOString(),
		});
	if (kind === 'wrong-user') {
		await f.patch(paths.project(f.project.id).meta, { default_role: 'editor' });
		f.api.deps.authenticator = {
			authenticate: async () => ({
				id: uid('other'),
				email: 'other@example.com',
				credential: { kind: 'development' },
			}),
		};
	}
	if (kind === 'revoked')
		await f.patch(paths.project(f.project.id).meta, {
			owner: uid('other'),
			members: [],
			default_role: 'none',
		});
	if (kind === 'deleted')
		await f.api.deps.services.notebooks.deleteNotebook(f.project.id, f.notebook.id, ACTOR);
	if (kind === 'labels')
		vi.spyOn(f.api.deps.services.notebooks, 'getSecurityLabels').mockResolvedValue({
			classification: 'restricted',
			compartments: [],
		});
	if (kind === 'suspended')
		vi.spyOn(f.api.deps.services.identities, 'isSuspended').mockResolvedValue(true);
	if (kind === 'no-auth') f.api.deps.authenticator = { authenticate: async () => null };
	if (['proxy-only', 'attach-only', 'wrong-project-grant'].includes(kind)) {
		f.api.deps.authenticator = {
			authenticate: async () => ({
				id: ACTOR,
				email: 'local@example.com',
				credential: {
					kind: 'personal-access-token',
					grant: {
						projects: kind === 'wrong-project-grant' ? [] : '*',
						actions:
							kind === 'proxy-only'
								? ['session.proxy']
								: kind === 'attach-only'
									? ['session.attach']
									: ['session.attach', 'session.proxy'],
					},
				},
			}),
		};
	}
	const before = await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId);
	const decision = await authorizeProxyRequest(request, f.api.deps);
	expect(decision.kind).toBe('reject');
	expect(
		(await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId)).last_heartbeat,
	).toBe(before.last_heartbeat);
});

it('renews a due heartbeat using CAS and refuses a concurrent termination', async () => {
	const f = await fixture();
	const key = paths.session(f.project.id, f.sessionId);
	await f.patch(key, { last_heartbeat: new Date(Date.now() - 61_000).toISOString() });
	expect((await authorizeProxyRequest(f.request(), f.api.deps)).kind).toBe('forward');
	expect(
		Date.now() -
			Date.parse(
				(await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId)).last_heartbeat,
			),
	).toBeLessThan(1_000);
	await f.patch(key, { last_heartbeat: new Date(Date.now() - 61_000).toISOString() });
	const heartbeat = f.api.deps.services.sessions.heartbeat.bind(f.api.deps.services.sessions);
	vi.spyOn(f.api.deps.services.sessions, 'heartbeat').mockImplementation(async (pid, sid) => {
		await f.api.deps.services.sessions.markTerminated(pid, sid);
		return heartbeat(pid, sid);
	});
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'reject',
		status: 410,
	});
});

it('does not revive a departed visit while a second tab remains active', async () => {
	const f = await fixture();
	const other = await expectOk(
		await f.api.request('POST', f.sessions, { mode: 'app', app_visit_id: 'two' }),
	);
	expect(other.session_id).toBe(f.sessionId);
	await expectOk(await f.api.request('POST', `${f.sessions}/${f.sessionId}/leave`, f.assignment));
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'reject',
		status: 410,
	});
	expect(
		(await authorizeProxyRequest(f.request(other.app_assignment as AppVisit), f.api.deps)).kind,
	).toBe('forward');
});

it('a leave winning the renewal CAS prevents forwarding on retry', async () => {
	const f = await fixture();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + 70_000);
	const second = createServices(f.bucket);
	const pool = new AppPoolService(f.bucket, second.sessions);
	const put = f.bucket.put.bind(f.bucket);
	let raced = false;
	vi.spyOn(f.bucket, 'put').mockImplementation(async (...args) => {
		if (!raced && args[0] === paths.appPool(f.project.id, f.notebook.id)) {
			raced = true;
			await pool.leave(f.project.id, f.notebook.id, ACTOR, f.sessionId, f.assignment);
		}
		return put(...args);
	});
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'reject',
		status: 410,
	});
	expect(raced).toBe(true);
});

it('new service instances observe revocation without a permission cache', async () => {
	const f = await fixture();
	const second = { ...f.api.deps, services: createServices(f.bucket) };
	expect((await authorizeProxyRequest(f.request(), second)).kind).toBe('forward');
	await f.patch(paths.project(f.project.id).meta, {
		owner: uid('other'),
		members: [],
		default_role: 'none',
	});
	for (const deps of [f.api.deps, second])
		expect(await authorizeProxyRequest(f.request(), deps)).toMatchObject({
			kind: 'reject',
			status: 403,
		});
});

it('keeps attach-specific resource security rather than checking only PAT scopes', async () => {
	const f = await fixture();
	await f.api.deps.services.projects.setSecurityLabels(
		f.project.id,
		{ classification: 'SECRET', compartments: [] },
		ACTOR,
	);
	const security = localResourceSecurity(['UNCLASSIFIED', 'SECRET'], makeSubjectContext());
	const evaluate = security.constraints.evaluate.bind(security.constraints);
	vi.spyOn(security.constraints, 'evaluate').mockImplementation(
		(subject, action, resource, signal) =>
			action === 'session.attach'
				? Promise.resolve({ satisfied: false, reason: 'constraint' })
				: evaluate(subject, action, resource, signal),
	);
	f.api.deps.resourceSecurity = security;
	const put = vi.spyOn(f.bucket, 'put');
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'reject',
		status: 404,
	});
	expect(put).not.toHaveBeenCalled();
});

it('uses a tighter session deadline observed during durable renewal', async () => {
	const f = await fixture();
	const key = paths.session(f.project.id, f.sessionId);
	await f.patch(key, { last_heartbeat: new Date(Date.now() - 61_000).toISOString() });
	const deadline = new Date(Date.now() + 15_000).toISOString();
	const heartbeat = f.api.deps.services.sessions.heartbeat.bind(f.api.deps.services.sessions);
	vi.spyOn(f.api.deps.services.sessions, 'heartbeat').mockImplementation(async (pid, sid) => {
		await f.patch(key, { authorization_expires_at: deadline });
		return heartbeat(pid, sid);
	});
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'forward',
		authorizationDeadline: Date.parse(deadline),
	});
});

it.each(['session', 'project'])(
	'returns a missing %s without waiting for speculative reads',
	async (missing) => {
		const f = await fixture();
		const notebook = deferred<never>();
		vi.spyOn(f.api.deps.services.notebooks, 'getSecurityLabels').mockReturnValue(notebook.promise);
		if (missing === 'session')
			vi.spyOn(f.api.deps.services.sessions, 'getSession').mockRejectedValue(new Error('missing'));
		else
			vi.spyOn(f.api.deps.services.projects, 'getProject').mockRejectedValue(new Error('missing'));
		try {
			expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
				kind: 'reject',
				status: 404,
			});
		} finally {
			// A later speculative rejection must already have a handler.
			notebook.reject(new Error('late notebook failure'));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	},
);

it.each(['no-auth', 'suspended'])('does not read route metadata for %s', async (kind) => {
	const f = await fixture();
	if (kind === 'no-auth') f.api.deps.authenticator = { authenticate: async () => null };
	else vi.spyOn(f.api.deps.services.identities, 'isSuspended').mockResolvedValue(true);
	const session = vi.spyOn(f.api.deps.services.sessions, 'getSession');
	const project = vi.spyOn(f.api.deps.services.projects, 'getProject');
	const notebook = vi.spyOn(f.api.deps.services.notebooks, 'getSecurityLabels');
	expect((await authorizeProxyRequest(f.request(), f.api.deps)).kind).toBe('reject');
	expect(session).not.toHaveBeenCalled();
	expect(project).not.toHaveBeenCalled();
	expect(notebook).not.toHaveBeenCalled();
});

it('fails closed when durable pool renewal cannot commit', async () => {
	const f = await fixture();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + 70_000);
	const before = await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId);
	const put = f.bucket.put.bind(f.bucket);
	vi.spyOn(f.bucket, 'put').mockImplementation((...args) => {
		if (args[0] === paths.appPool(f.project.id, f.notebook.id))
			return Promise.reject(new Error('storage unavailable'));
		return put(...args);
	});
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'reject',
		status: 503,
	});
	expect(
		(await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId)).last_heartbeat,
	).toBe(before.last_heartbeat);
});

it('does not forward to an origin changed during durable renewal', async () => {
	const f = await fixture();
	const key = paths.session(f.project.id, f.sessionId);
	await f.patch(key, { last_heartbeat: new Date(Date.now() - 61_000).toISOString() });
	const heartbeat = f.api.deps.services.sessions.heartbeat.bind(f.api.deps.services.sessions);
	vi.spyOn(f.api.deps.services.sessions, 'heartbeat').mockImplementation(async (pid, sid) => {
		await f.patch(key, { sandbox_origin_url: 'http://replacement.invalid' });
		return heartbeat(pid, sid);
	});
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'reject',
		status: 503,
	});
});

it('keeps the earlier attach authorization deadline', async () => {
	const f = await fixture();
	await f.api.deps.services.projects.setSecurityLabels(
		f.project.id,
		{ classification: 'SECRET', compartments: [] },
		ACTOR,
	);
	const proxyExpiry = new Date(Date.now() + 60_000).toISOString();
	const attachExpiry = new Date(Date.now() + 15_000).toISOString();
	const security = localResourceSecurity(
		['UNCLASSIFIED', 'SECRET'],
		makeSubjectContext({ expiresAt: proxyExpiry }),
	);
	const resolve = vi.spyOn(security.subjectContext!, 'resolve');
	resolve
		.mockResolvedValueOnce(makeSubjectContext({ expiresAt: proxyExpiry }))
		.mockResolvedValueOnce(makeSubjectContext({ expiresAt: attachExpiry }));
	f.api.deps.resourceSecurity = security;
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'forward',
		authorizationDeadline: Date.parse(attachExpiry),
	});
});

it('keeps an admitted visit on its source version after a new publication', async () => {
	const f = await fixture();
	const before = await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId);
	await f.api.deps.services.notebooks.commitSession(
		f.project.id,
		f.notebook.id,
		{ code: 'updated' },
		ACTOR,
	);
	const latest = await expectOk(
		await f.api.request('POST', f.sessions, { mode: 'app', app_visit_id: 'new-version' }),
	);
	expect(latest.session_id).not.toBe(f.sessionId);
	expect(latest.source_version_id).not.toBe(before.source_version_id);
	expect(await authorizeProxyRequest(f.request(), f.api.deps)).toMatchObject({
		kind: 'forward',
		sessionId: f.sessionId,
	});
	const after = await f.api.deps.services.sessions.getSession(f.project.id, f.sessionId);
	expect(after.source_version_id).toBe(before.source_version_id);
});
