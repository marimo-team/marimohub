import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AuthorizationService,
	AppPoolService,
	ProjectId,
	NotFoundError,
	UnavailableError,
	createServices,
	paths,
} from '@marimo-hub/core';
import type { AppVisit, SessionId, TokenGrant } from '@marimo-hub/core';
import {
	ACTOR,
	localResourceSecurity,
	makeFakeCompute,
	makeSubjectContext,
} from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

async function fixture() {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject({ name: 'P', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'App', description: '', code: 'original' },
		ACTOR,
	);
	const resourceSecurity = localResourceSecurity(['PUBLIC', 'SECRET'], makeSubjectContext());
	const client = createTestApi({ bucket, compute: makeFakeCompute(), deps: { resourceSecurity } });
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	const admission = await expectOk<{ session_id: SessionId; app_assignment: AppVisit }>(
		await client.request('POST', path, { mode: 'app', app_visit_id: 'tab' }),
	);
	const session = await services.sessions.getSession(project.id, admission.session_id);
	const heartbeat = () =>
		client.request('POST', `${path}/${admission.session_id}/heartbeat`, admission.app_assignment);
	const poolKey = paths.appPool(project.id, notebook.id);
	const sessionKey = paths.session(project.id, admission.session_id);
	return {
		bucket,
		services,
		project,
		notebook,
		client,
		session,
		admission,
		heartbeat,
		poolKey,
		sessionKey,
		resourceSecurity,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('heartbeat read scheduling', () => {
	it('starts project and session reads before either resolves, then preserves authorization order', async () => {
		const f = await fixture();
		const projectRead = Promise.withResolvers<typeof f.project>();
		const sessionRead = Promise.withResolvers<typeof f.session>();
		const projectStarted = Promise.withResolvers<void>();
		const sessionStarted = Promise.withResolvers<void>();
		vi.spyOn(f.client.deps.services.projects, 'getProject').mockImplementation(() => {
			projectStarted.resolve();
			return projectRead.promise;
		});
		vi.spyOn(f.client.deps.services.sessions, 'getSession').mockImplementation(() => {
			sessionStarted.resolve();
			return sessionRead.promise;
		});
		const labels = vi.spyOn(f.client.deps.services.notebooks, 'getSecurityLabels');
		const authorize = vi.spyOn(AuthorizationService.prototype, 'authorize');
		const pending = f.heartbeat();
		try {
			await Promise.all([projectStarted.promise, sessionStarted.promise]);
			expect(authorize).not.toHaveBeenCalled();
			expect(labels).not.toHaveBeenCalled();
			sessionRead.resolve(f.session);
			await Promise.resolve();
			expect(labels).not.toHaveBeenCalled();
		} finally {
			projectRead.resolve(f.project);
			sessionRead.resolve(f.session);
		}
		await expectOk(await pending);
		expect(authorize.mock.calls.slice(0, 2).map((call) => call[1])).toEqual([
			'project.read',
			'session.attach',
		]);
	});

	it.each(['early', 'late'] as const)(
		'returns project denial without waiting for the session and handles its %s rejection',
		async (timing) => {
			const f = await fixture();
			const sessionRead = Promise.withResolvers<typeof f.session>();
			const sessionStarted = Promise.withResolvers<void>();
			vi.spyOn(f.client.deps.services.sessions, 'getSession').mockImplementation(() => {
				sessionStarted.resolve();
				return sessionRead.promise;
			});
			const authz = AuthorizationService.prototype;
			const authorize = authz.authorize;
			vi.spyOn(authz, 'authorize').mockImplementation(async function (
				this: AuthorizationService,
				...args
			) {
				await sessionStarted.promise;
				if (timing === 'early') sessionRead.reject(new UnavailableError('private session failure'));
				return args[1] === 'project.read'
					? { allowed: false, category: 'visibility', role: null }
					: authorize.apply(this, args);
			});
			const put = vi.spyOn(f.bucket, 'put');
			try {
				await expectError(await f.heartbeat(), 404, 'NOT_FOUND');
				expect(put).not.toHaveBeenCalled();
			} finally {
				sessionRead.reject(new UnavailableError('private session failure'));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},
	);

	it.each([
		new NotFoundError('Project missing'),
		new UnavailableError('Project storage unavailable'),
	])('preserves project storage failure precedence: $code', async (error) => {
		const f = await fixture();
		const sessionRead = Promise.withResolvers<typeof f.session>();
		vi.spyOn(f.client.deps.services.sessions, 'getSession').mockReturnValue(sessionRead.promise);
		vi.spyOn(f.client.deps.services.projects, 'getProject').mockRejectedValue(error);
		const labels = vi.spyOn(f.client.deps.services.notebooks, 'getSecurityLabels');
		const renew = vi.spyOn(f.client.deps.services.sessions, 'heartbeat');
		const put = vi.spyOn(f.bucket, 'put');
		try {
			const failure = await expectError(await f.heartbeat(), error.status, error.code);
			expect(failure.message).toBe(error.message);
			expect(labels).not.toHaveBeenCalled();
			expect(renew).not.toHaveBeenCalled();
			expect(put).not.toHaveBeenCalled();
		} finally {
			sessionRead.reject(new UnavailableError('Private session failure'));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});

	it.each([new NotFoundError('Session missing'), new UnavailableError('Session unavailable')])(
		'preserves the session error after project authorization: $code',
		async (error) => {
			const f = await fixture();
			vi.spyOn(f.client.deps.services.sessions, 'getSession').mockRejectedValue(error);
			const put = vi.spyOn(f.bucket, 'put');
			await expectError(
				await f.heartbeat(),
				error instanceof NotFoundError ? 404 : 503,
				error.code,
			);
			expect(put).not.toHaveBeenCalled();
		},
	);

	it.each(['project.read', 'app.read', 'notebook.read', 'session.attach'] as const)(
		'retains the %s gate before renewal',
		async (gate) => {
			const f = await fixture();
			const authz = AuthorizationService.prototype;
			if (gate === 'app.read') vi.spyOn(authz, 'appReadAction').mockReturnValue('app.read');
			if (gate === 'notebook.read')
				vi.spyOn(f.client.deps.services.notebooks, 'getSecurityLabels').mockResolvedValue({
					classification: 'SECRET',
					compartments: [],
				});
			const authorize = authz.authorize;
			const calls = vi.spyOn(authz, 'authorize').mockImplementation(function (
				this: AuthorizationService,
				...args
			) {
				if (gate !== 'session.attach' && args[1] === 'session.attach')
					return Promise.resolve({ allowed: true, role: 'editor' });
				const denied =
					gate === 'notebook.read'
						? args[1] === 'project.read' &&
							args[2].kind === 'project' &&
							args[2].notebookLabels != null
						: args[1] === gate;
				return denied
					? Promise.resolve({
							allowed: false,
							category: gate === 'session.attach' ? 'role' : 'visibility',
							role: null,
						})
					: authorize.apply(this, args);
			});
			const put = vi.spyOn(f.bucket, 'put');
			await expectError(await f.heartbeat(), gate === 'session.attach' ? 403 : 404);
			expect(put).not.toHaveBeenCalled();
			if (gate !== 'session.attach')
				expect(calls.mock.calls.some((call) => call[1] === 'session.attach')).toBe(false);
		},
	);
});

describe('heartbeat authorization boundaries', () => {
	it.each([
		'project grant',
		'action grant',
		'suspended',
		'deleted project',
		'deleted notebook',
	] as const)('rejects %s without renewal', async (reason) => {
		const f = await fixture();
		if (reason === 'project grant' || reason === 'action grant') {
			const grant: TokenGrant = {
				actions: reason === 'action grant' ? ['project.read'] : '*',
				projects:
					reason === 'project grant' ? [ProjectId.parse('proj-0000000000000002')] : [f.project.id],
			};
			vi.spyOn(f.client.deps.authenticator, 'authenticate').mockResolvedValue({
				id: ACTOR,
				email: `${ACTOR}@example.com`,
				credential: { kind: 'personal-access-token', grant },
			});
		} else if (reason === 'suspended')
			await f.client.deps.services.identities.setSuspension(ACTOR, true);
		else if (reason === 'deleted project')
			await f.services.projects.deleteProject(f.project.id, ACTOR);
		else await f.services.notebooks.deleteNotebook(f.project.id, f.notebook.id, ACTOR);
		const put = vi.spyOn(f.bucket, 'put');
		await expectError(
			await f.heartbeat(),
			reason === 'suspended' || reason === 'action grant' ? 403 : 404,
		);
		expect(
			put.mock.calls.filter(([key]) => key === f.poolKey || key === f.sessionKey),
		).toHaveLength(0);
	});
});

describe('heartbeat dependency failures', () => {
	it.each(['notebook', 'pool', 'session mutation'] as const)(
		'fails without writes when the %s read fails, then recovers on retry',
		async (record) => {
			const f = await fixture();
			const keyToFail =
				record === 'notebook'
					? paths.project(f.project.id).notebook(f.notebook.id).meta
					: record === 'pool'
						? f.poolKey
						: f.sessionKey;
			const get = f.bucket.get.bind(f.bucket);
			let reads = 0;
			const failure = vi.spyOn(f.bucket, 'get').mockImplementation((key) => {
				if (key === keyToFail && ++reads === (record === 'session mutation' ? 2 : 1))
					throw new UnavailableError('Storage temporarily unavailable');
				return get(key);
			});
			const put = vi.spyOn(f.bucket, 'put');
			await expectError(await f.heartbeat(), 503, 'SERVICE_UNAVAILABLE');
			expect(put).not.toHaveBeenCalled();
			failure.mockRestore();
			expect((await expectOk(await f.heartbeat())).status).toBe('running');
			expect(put).not.toHaveBeenCalled();
		},
	);

	it.each(['pool', 'session'] as const)(
		'does not acknowledge a failed %s renewal write, and safely retries a partial renewal',
		async (record) => {
			const f = await fixture();
			const beforePool = await (await f.bucket.get(f.poolKey))!.text();
			const now = Date.now();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(now + 61_000);
			const keyToFail = record === 'pool' ? f.poolKey : f.sessionKey;
			const put = f.bucket.put.bind(f.bucket);
			const failure = vi.spyOn(f.bucket, 'put').mockImplementation((key, value, options) => {
				if (key === keyToFail) throw new UnavailableError('Renewal persistence failed');
				return put(key, value, options);
			});
			await expectError(await f.heartbeat(), 503, 'SERVICE_UNAVAILABLE');
			expect(
				(await f.services.sessions.getSession(f.project.id, f.session.session_id)).last_heartbeat,
			).toBe(f.session.last_heartbeat);
			if (record === 'pool') {
				expect(await (await f.bucket.get(f.poolKey))!.text()).toBe(beforePool);
				expect(failure.mock.calls.some(([key]) => key === f.sessionKey)).toBe(false);
			} else expect(await (await f.bucket.get(f.poolKey))!.text()).not.toBe(beforePool);
			failure.mockRestore();
			const retryWrites = vi.spyOn(f.bucket, 'put');
			const retried = await expectOk(await f.heartbeat());
			expect(retried.status).toBe('running');
			expect(retried.last_heartbeat).toBe(new Date().toISOString());
			expect(retryWrites.mock.calls.map(([key]) => key)).toEqual(
				record === 'pool' ? [f.poolKey, f.sessionKey] : [f.sessionKey],
			);
			expect(retryWrites.mock.calls.every(([, , options]) => options?.onlyIfEtagMatches)).toBe(
				true,
			);
		},
	);

	it.each([
		['project', 'context'],
		['project', 'constraints'],
		['notebook', 'context'],
		['notebook', 'constraints'],
	] as const)(
		'fails closed when %s authorization loses its %s provider',
		async (scope, provider) => {
			const f = await fixture();
			const labels = { classification: 'SECRET', compartments: [] };
			if (scope === 'project')
				await f.services.projects.setSecurityLabels(f.project.id, labels, ACTOR);
			else await f.services.notebooks.setSecurityLabels(f.project.id, f.notebook.id, labels, ACTOR);
			if (provider === 'context')
				vi.spyOn(f.resourceSecurity.subjectContext!, 'resolve').mockRejectedValue(
					new Error('Provider unavailable'),
				);
			else
				vi.spyOn(f.resourceSecurity.constraints, 'evaluate').mockRejectedValue(
					new Error('Provider unavailable'),
				);
			const renew = vi.spyOn(f.client.deps.services.sessions, 'heartbeat');
			const put = vi.spyOn(f.bucket, 'put');
			const failure = await expectError(await f.heartbeat(), 404, 'NOT_FOUND');
			expect(failure.message).not.toContain('Provider unavailable');
			expect(renew).not.toHaveBeenCalled();
			expect(put).not.toHaveBeenCalled();
		},
	);
});

describe('due heartbeat races', () => {
	it.each(['leave', 'terminate'] as const)(
		'rechecks CAS state when %s wins before renewal writes',
		async (race) => {
			const f = await fixture();
			const now = Date.now();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(now + 61_000);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const keyToPause = race === 'leave' ? f.poolKey : f.sessionKey;
			const put = f.bucket.put.bind(f.bucket);
			let paused = false;
			vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === keyToPause && !paused) {
					paused = true;
					expect(options?.onlyIfEtagMatches).toBeTruthy();
					entered.resolve();
					await release.promise;
				}
				return put(key, value, options);
			});
			const pending = f.heartbeat();
			await entered.promise;
			try {
				if (race === 'leave')
					await new AppPoolService(f.bucket, f.services.sessions).leave(
						f.project.id,
						f.notebook.id,
						ACTOR,
						f.admission.session_id,
						f.admission.app_assignment,
					);
				else await f.services.sessions.terminate(f.project.id, f.admission.session_id);
			} finally {
				release.resolve();
			}
			if (race === 'leave') {
				await expectError(await pending, 409, 'CONFLICT');
				const pool = await new AppPoolService(f.bucket, f.services.sessions).store.read(
					f.project.id,
					f.notebook.id,
				);
				expect(pool!.assignments.every((assignment) => assignment.visits.length === 0)).toBe(true);
			} else {
				const response = await expectOk(await pending);
				expect(response.status).toBe('terminated');
				expect(response.sandbox_url).toBeUndefined();
				expect(response.can.attach).toBe(false);
			}
		},
	);
});
