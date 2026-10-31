import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	KERNEL_AUTH_TOKEN_PATTERN,
	NotFoundError,
	paths,
	ProjectId,
	ProxyExposure,
	signProxyToken,
	SubdomainExposure,
	UnavailableError,
} from '@marimo-hub/core';
import type { Authenticator, SessionId, TokenGrant, UserId } from '@marimo-hub/core';
import {
	ACTOR,
	localResourceSecurity,
	makeFakeCompute,
	makeSubjectContext,
	RecordingBucket,
	TEST_KERNEL_AUTH_TOKEN,
	uid,
} from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createApi } from './createApi';
import { createInitializedBucket, makeTestDeps } from './testing';
import { authorizeProxyRequest, forwardHttp, sandboxProxyMiddleware } from './sandboxProxy';

const SECRET = 'a-test-signing-secret-at-least-32-bytes-long!!';
const STRANGER = uid('user_stranger');
const ORIGIN = 'http://kernel.internal:2718';

function authAs(userId: UserId | null): Authenticator {
	return {
		authenticate: async () =>
			userId
				? {
						id: userId,
						email: `${userId}@example.com`,
						credential: { kind: 'development' as const },
					}
				: null,
	};
}

function authWithGrant(grant: TokenGrant): Authenticator {
	return {
		authenticate: async () => ({
			id: ACTOR,
			email: `${ACTOR}@example.com`,
			credential: { kind: 'personal-access-token', grant },
		}),
	};
}

describe('authorizeProxyRequest', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let sessionId: SessionId;
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
			kernel_auth_token: TEST_KERNEL_AUTH_TOKEN,
		});
		sessionId = session.session_id;
		// Mark running with a server-reachable origin (proxy-mode provisioning).
		await services.sessions.setRunning(pid, session.session_id, '/proxy/x/', false, ORIGIN);
		token = await signProxyToken(pid, sessionId, SECRET);
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

	function proxyRequest(path = '/'): Request {
		return req(`/proxy/${token}${path}`);
	}

	function recordedDeps(userId: UserId | null = ACTOR) {
		const recorded = new RecordingBucket(bucket);
		const d = { ...deps(userId), bucket: recorded, services: createServices(recorded) };
		const sessionReads = () =>
			recorded.calls.get.filter((key) => key === paths.session(pid, sessionId)).length;
		return { d, recorded, sessionReads };
	}

	it('starts a cold session read while the suspension check is pending', async () => {
		const { d, sessionReads } = recordedDeps();
		const suspension = Promise.withResolvers<boolean>();
		vi.spyOn(d.services.identities, 'isSuspended').mockReturnValue(suspension.promise);
		const decision = authorizeProxyRequest(proxyRequest(), d);
		await vi.waitFor(() => expect(sessionReads()).toBe(1));
		suspension.resolve(false);
		expect(await decision).toMatchObject({ kind: 'forward' });
	});

	it.each([4_999, 5_000, 10_000])(
		'bounds speculative session reuse to five seconds (suspension delay: %i ms)',
		async (delay) => {
			const d = deps(ACTOR);
			const session = await d.services.sessions.getSession(pid, sessionId);
			const sessionRead = vi
				.spyOn(d.services.sessions, 'getSession')
				.mockResolvedValueOnce(session);
			const suspension = Promise.withResolvers<boolean>();
			vi.spyOn(d.services.identities, 'isSuspended').mockReturnValue(suspension.promise);
			const startedAt = Date.now();
			const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
			const decision = authorizeProxyRequest(proxyRequest(), d);
			try {
				await vi.waitFor(() => expect(sessionRead).toHaveBeenCalledTimes(1));
				await createServices(bucket).sessions.terminate(pid, sessionId);
				clock.mockReturnValue(startedAt + delay);
				suspension.resolve(false);
				expect(await decision).toMatchObject(
					delay < 5_000 ? { kind: 'forward' } : { kind: 'reject', status: 410 },
				);
				expect(sessionRead).toHaveBeenCalledTimes(delay < 5_000 ? 1 : 2);
			} finally {
				suspension.resolve(false);
				await decision;
				clock.mockRestore();
			}
		},
	);

	it('fails closed when speculative session revalidation fails and retries on the next request', async () => {
		const d = deps(ACTOR);
		const session = await d.services.sessions.getSession(pid, sessionId);
		const sessionRead = vi
			.spyOn(d.services.sessions, 'getSession')
			.mockResolvedValueOnce(session)
			.mockRejectedValueOnce(new UnavailableError('storage down'));
		const suspension = Promise.withResolvers<boolean>();
		vi.spyOn(d.services.identities, 'isSuspended').mockReturnValue(suspension.promise);
		const startedAt = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
		const decision = authorizeProxyRequest(proxyRequest(), d);
		try {
			await vi.waitFor(() => expect(sessionRead).toHaveBeenCalledTimes(1));
			clock.mockReturnValue(startedAt + 5_000);
			suspension.resolve(false);
			expect(await decision).toMatchObject({ kind: 'reject', status: 404 });
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({ kind: 'forward' });
			expect(sessionRead).toHaveBeenCalledTimes(3);
		} finally {
			suspension.resolve(false);
			await decision;
			clock.mockRestore();
		}
	});

	it('preserves suspension precedence when the speculative session read fails', async () => {
		const d = deps(ACTOR);
		vi.spyOn(d.services.sessions, 'getSession').mockRejectedValue(new Error('missing'));
		vi.spyOn(d.services.identities, 'isSuspended').mockResolvedValue(true);
		expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
			kind: 'reject',
			status: 403,
			code: 'USER_SUSPENDED',
		});
	});

	it('reuses admission reads for five seconds while routing each path and query independently', async () => {
		const { d, sessionReads } = recordedDeps();
		const projectRead = vi.spyOn(d.services.projects, 'getProject');
		const labelsRead = vi.spyOn(d.services.notebooks, 'getSecurityLabels');
		const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
		try {
			for (const path of ['/assets/a.js?v=1', '/api/kernel?cell=2']) {
				expect(await authorizeProxyRequest(proxyRequest(path), d)).toMatchObject({
					kind: 'forward',
					targetUrl: `${ORIGIN}/proxy/${token}${path}`,
				});
			}
			expect(sessionReads()).toBe(1);
			expect(projectRead).toHaveBeenCalledTimes(1);
			expect(labelsRead).toHaveBeenCalledTimes(1);
			clock.mockReturnValue(Date.now() + 5_000);
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'forward',
			});
			expect(sessionReads()).toBe(2);
			expect(projectRead).toHaveBeenCalledTimes(2);
			expect(labelsRead).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});

	it('refreshes an admission that expires while suspension verification is pending', async () => {
		const { d } = recordedDeps();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
		const suspension = Promise.withResolvers<boolean>();
		try {
			await authorizeProxyRequest(proxyRequest(), d);
			await d.services.sessions.terminate(pid, sessionId);
			vi.spyOn(d.services.identities, 'isSuspended').mockReturnValue(suspension.promise);
			const decision = authorizeProxyRequest(proxyRequest(), d);
			await vi.waitFor(() => expect(d.services.identities.isSuspended).toHaveBeenCalled());
			clock.mockReturnValue(Date.now() + 5_000);
			suspension.resolve(false);
			expect(await decision).toMatchObject({ kind: 'reject', status: 410 });
		} finally {
			suspension.resolve(false);
			clock.mockRestore();
		}
	});

	it.each(['entitlementsExpiresAt', 'credential'] as const)(
		'caps admission freshness at the %s expiry',
		async (field) => {
			const { d, sessionReads } = recordedDeps();
			const now = Date.now();
			const user = (await d.authenticator.authenticate(req('/')))!;
			const expiry = new Date(now + 1000).toISOString();
			vi.spyOn(d.authenticator, 'authenticate').mockResolvedValue({
				...user,
				...(field === 'credential'
					? { credential: { ...user.credential, expiresAt: expiry } }
					: { entitlementsExpiresAt: expiry }),
			});
			const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
			try {
				await authorizeProxyRequest(proxyRequest(), d);
				clock.mockReturnValue(now + 999);
				await authorizeProxyRequest(proxyRequest(), d);
				expect(sessionReads()).toBe(1);
				clock.mockReturnValue(now + 1000);
				await authorizeProxyRequest(proxyRequest(), d);
				expect(sessionReads()).toBe(2);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each(['session', 'project', 'labels'] as const)(
		'fails closed on a %s refresh error and retries without retaining the denial',
		async (stage) => {
			const { d, sessionReads } = recordedDeps();
			const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
			try {
				expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
					kind: 'forward',
				});
				if (stage === 'session')
					vi.spyOn(d.services.sessions, 'getSession').mockRejectedValueOnce(
						new UnavailableError('storage down'),
					);
				else if (stage === 'project')
					vi.spyOn(d.services.projects, 'getProject').mockRejectedValueOnce(
						new UnavailableError('storage down'),
					);
				else
					vi.spyOn(d.services.notebooks, 'getSecurityLabels').mockRejectedValueOnce(
						new UnavailableError('storage down'),
					);
				clock.mockReturnValue(Date.now() + 5_000);
				expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
					kind: 'reject',
					status: stage === 'labels' ? 503 : 404,
				});
				expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
					kind: 'forward',
				});
				expect(sessionReads()).toBe(stage === 'session' ? 2 : 3);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each([false, true])(
		'coalesces concurrent admissions and recovers after a failed load (failure: %s)',
		async (fails) => {
			const { d } = recordedDeps();
			const project = await d.services.projects.getProject(pid);
			const projectRead = Promise.withResolvers<typeof project>();
			const projectSpy = vi
				.spyOn(d.services.projects, 'getProject')
				.mockReturnValueOnce(projectRead.promise);
			const suspensionSpy = vi.spyOn(d.services.identities, 'isSuspended');
			const paths = ['/assets/one.js?v=1', '/assets/two.js?v=2'];
			const decisions = paths.map((path) => authorizeProxyRequest(proxyRequest(path), d));
			try {
				await vi.waitFor(() => expect(suspensionSpy).toHaveBeenCalledTimes(2));
				if (fails) projectRead.reject(new UnavailableError('storage down'));
				else projectRead.resolve(project);
				for (const [index, decision] of (await Promise.all(decisions)).entries()) {
					expect(decision).toMatchObject(
						fails
							? { kind: 'reject', status: 404 }
							: { kind: 'forward', targetUrl: `${ORIGIN}/proxy/${token}${paths[index]}` },
					);
				}
				expect(projectSpy).toHaveBeenCalledTimes(1);
				expect(await authorizeProxyRequest(proxyRequest('/retry'), d)).toMatchObject({
					kind: 'forward',
				});
				expect(projectSpy).toHaveBeenCalledTimes(fails ? 2 : 1);
			} finally {
				projectRead.resolve(project);
				await Promise.all(decisions);
			}
		},
	);

	it('does not start a session read for a request that joins an in-flight admission load', async () => {
		const { d, sessionReads } = recordedDeps();
		const project = await d.services.projects.getProject(pid);
		const projectRead = Promise.withResolvers<typeof project>();
		const projectSpy = vi
			.spyOn(d.services.projects, 'getProject')
			.mockReturnValueOnce(projectRead.promise);
		const suspensionSpy = vi.spyOn(d.services.identities, 'isSuspended');
		const first = authorizeProxyRequest(proxyRequest('/one'), d);
		let second: Promise<unknown> | undefined;
		try {
			await vi.waitFor(() => expect(projectSpy).toHaveBeenCalledTimes(1));
			second = authorizeProxyRequest(proxyRequest('/two'), d);
			await vi.waitFor(() => expect(suspensionSpy).toHaveBeenCalledTimes(2));
			projectRead.resolve(project);
			expect(await first).toMatchObject({ kind: 'forward' });
			expect(await second).toMatchObject({ kind: 'forward' });
			expect(sessionReads()).toBe(1);
			expect(projectSpy).toHaveBeenCalledTimes(1);
		} finally {
			projectRead.resolve(project);
			await Promise.all([first, second]);
		}
	});

	it('does not extend the cache window by the time spent loading admission', async () => {
		const { d, sessionReads } = recordedDeps();
		const project = await d.services.projects.getProject(pid);
		const projectRead = Promise.withResolvers<typeof project>();
		const projectSpy = vi
			.spyOn(d.services.projects, 'getProject')
			.mockReturnValueOnce(projectRead.promise);
		const startedAt = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
		const decision = authorizeProxyRequest(proxyRequest(), d);
		try {
			await vi.waitFor(() => expect(projectSpy).toHaveBeenCalledTimes(1));
			clock.mockReturnValue(startedAt + 4_000);
			projectRead.resolve(project);
			expect(await decision).toMatchObject({ kind: 'forward' });
			clock.mockReturnValue(startedAt + 4_999);
			await authorizeProxyRequest(proxyRequest(), d);
			expect(sessionReads()).toBe(1);
			clock.mockReturnValue(startedAt + 5_000);
			await authorizeProxyRequest(proxyRequest(), d);
			expect(sessionReads()).toBe(2);
		} finally {
			projectRead.resolve(project);
			await decision;
			clock.mockRestore();
		}
	});

	it('rejects a forged signature even when the user and session have a cached admission', async () => {
		const { d, sessionReads } = recordedDeps();
		const authenticate = vi.spyOn(d.authenticator, 'authenticate');
		await authorizeProxyRequest(proxyRequest(), d);
		const forged = await signProxyToken(pid, sessionId, 'another-secret');
		expect(await authorizeProxyRequest(req(`/proxy/${forged}/`), d)).toMatchObject({
			kind: 'reject',
			status: 403,
		});
		expect(authenticate).toHaveBeenCalledTimes(1);
		expect(sessionReads()).toBe(1);
	});

	it('does not share a successful admission with another user', async () => {
		const { d, sessionReads } = recordedDeps();
		expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
			kind: 'forward',
		});
		d.authenticator = authAs(STRANGER);
		expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
			kind: 'reject',
			status: 403,
		});
		expect(sessionReads()).toBe(2);
	});

	it('does not share admissions across dependency instances', async () => {
		const first = recordedDeps();
		const second = recordedDeps();
		await authorizeProxyRequest(proxyRequest(), first.d);
		await authorizeProxyRequest(proxyRequest(), second.d);
		expect(first.sessionReads()).toBe(1);
		expect(second.sessionReads()).toBe(1);
	});

	it.each([
		{ actions: ['project.read'], projects: '*', status: 403 },
		{ actions: '*', projects: [ProjectId.parse('proj-0000000000000002')], status: 404 },
	] satisfies (TokenGrant & { status: number })[])(
		'does not reuse a browser admission for a restricted credential ($status)',
		async ({ actions, projects, status }) => {
			const { d, sessionReads } = recordedDeps();
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'forward',
			});
			d.authenticator = authWithGrant({ actions, projects });
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'reject',
				status,
			});
			expect(sessionReads()).toBe(2);
		},
	);

	it.each(['email', 'credential', 'groups', 'entitlements', 'entitlementsExpiresAt'] as const)(
		'partitions admissions when the principal %s changes',
		async (field) => {
			const { d, sessionReads } = recordedDeps();
			const user = (await d.authenticator.authenticate(req('/')))!;
			const values = {
				email: 'changed@example.com',
				credential: { ...user.credential, subjectContextRef: 'another-context' },
				groups: ['another-group'],
				entitlements: ['project-creator'] as const,
				entitlementsExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			};
			await authorizeProxyRequest(proxyRequest(), d);
			vi.spyOn(d.authenticator, 'authenticate').mockResolvedValue({
				...user,
				[field]: values[field],
			});
			await authorizeProxyRequest(proxyRequest(), d);
			expect(sessionReads()).toBe(2);
		},
	);

	it('does not cache a denial after membership is granted', async () => {
		const { d, sessionReads } = recordedDeps(STRANGER);
		expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
			kind: 'reject',
			status: 403,
		});
		await d.services.projects.addMember(pid, { user_id: STRANGER }, 'editor', ACTOR);
		expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
			kind: 'forward',
		});
		expect(sessionReads()).toBe(2);
	});

	it.each(['stop', 'delete', 'revoke', 'labels'] as const)(
		'enforces %s after the admission window',
		async (change) => {
			const { d } = recordedDeps(STRANGER);
			await d.services.projects.addMember(pid, { user_id: STRANGER }, 'editor', ACTOR);
			const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
			try {
				expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
					kind: 'forward',
				});
				if (change === 'stop') await d.services.sessions.terminate(pid, sessionId);
				else if (change === 'delete') await d.services.projects.deleteProject(pid, ACTOR);
				else if (change === 'revoke') await d.services.projects.removeMember(pid, STRANGER, ACTOR);
				else
					await d.services.projects.setSecurityLabels(
						pid,
						{ classification: 'SECRET', compartments: [] },
						ACTOR,
					);
				expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
					kind: 'forward',
				});
				clock.mockReturnValue(Date.now() + 5_000);
				expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
					kind: 'reject',
				});
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each(['unauthenticated', 'suspended', 'unavailable'] as const)(
		'enforces %s on a cached admission',
		async (state) => {
			const { d, sessionReads } = recordedDeps();
			await authorizeProxyRequest(proxyRequest(), d);
			if (state === 'unauthenticated') d.authenticator = authAs(null);
			else if (state === 'suspended')
				vi.spyOn(d.services.identities, 'isSuspended').mockResolvedValue(true);
			else
				vi.spyOn(d.services.identities, 'isSuspended').mockRejectedValue(
					new UnavailableError('down'),
				);
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'reject',
				status: state === 'unauthenticated' ? 401 : state === 'suspended' ? 403 : 503,
			});
			expect(sessionReads()).toBe(1);
		},
	);

	it('keeps kernel and surface admissions separate and rebuilds surface URLs on hits', async () => {
		const { d, sessionReads } = recordedDeps();
		await d.services.sessions.setSurfaceState(pid, sessionId, 'vscode', {
			status: 'ready',
			origin_url: 'http://vscode.internal:8443',
			proxy_path: 'strip-prefix',
		});
		const before = sessionReads();
		await authorizeProxyRequest(proxyRequest('/assets/a.js'), d);
		for (const path of ['/stable/a.js?v=1', '/stable/b.js?v=2']) {
			const decision = await authorizeProxyRequest(req(`/surface-proxy/${token}/vscode${path}`), d);
			expect(decision).toMatchObject({
				kind: 'forward',
				targetUrl: `http://vscode.internal:8443${path}`,
			});
			expect(decision).not.toHaveProperty('kernelAuthToken');
		}
		expect(sessionReads() - before).toBe(2);
	});

	it('rejects a cached admission at its authorization deadline before five seconds elapse', async () => {
		const { d, sessionReads } = recordedDeps();
		const session = await d.services.sessions.getSession(pid, sessionId);
		const deadline = Date.now() + 1000;
		vi.spyOn(d.services.sessions, 'getSession').mockResolvedValue({
			...session,
			authorization_expires_at: new Date(deadline).toISOString(),
		});
		const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1000);
		try {
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'forward',
				authorizationDeadline: deadline,
			});
			clock.mockReturnValue(deadline);
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'reject',
				status: 410,
			});
			expect(d.services.sessions.getSession).toHaveBeenCalledTimes(1);
			expect(sessionReads()).toBe(1);
		} finally {
			clock.mockRestore();
		}
	});

	async function runningApp(services: ReturnType<typeof createServices>) {
		const { notebook_id: notebookId } = await services.sessions.getSession(pid, sessionId);
		const app = await services.sessions.createSession({
			project_id: pid,
			notebook_id: notebookId,
			user_id: ACTOR,
			mode: 'app',
		});
		await services.sessions.setRunning(pid, app.session_id, '/proxy/x/', false, ORIGIN);
		const appToken = await signProxyToken(pid, app.session_id, SECRET);
		return { notebookId, sessionId: app.session_id, request: () => req(`/proxy/${appToken}/`) };
	}

	it('caches metadata for app requests while reading the session on every request', async () => {
		const { d, recorded, sessionReads } = recordedDeps();
		const app = await runningApp(d.services);
		sessionId = app.sessionId;
		recorded.calls.get.length = 0;
		for (let i = 0; i < 2; i++) {
			expect(await authorizeProxyRequest(app.request(), d)).toMatchObject({ kind: 'forward' });
		}
		expect(recorded.calls.get.filter((key) => key === paths.project(pid).meta)).toHaveLength(1);
		expect(
			recorded.calls.get.filter((key) => key === paths.project(pid).notebook(app.notebookId).meta),
		).toHaveLength(1);
		expect(sessionReads()).toBe(2);
	});

	it.each(['project', 'notebook'] as const)(
		'rejects a warm app admission during %s storage failure and retries after recovery',
		async (resource) => {
			const { d } = recordedDeps();
			const app = await runningApp(d.services);
			expect(await authorizeProxyRequest(app.request(), d)).toMatchObject({ kind: 'forward' });
			const key =
				resource === 'project'
					? paths.project(pid).meta
					: paths.project(pid).notebook(app.notebookId).meta;
			const head = d.bucket.head.bind(d.bucket);
			const failure = vi.spyOn(d.bucket, 'head').mockImplementation(async (requestedKey) => {
				if (requestedKey === key) throw new UnavailableError('Storage unavailable');
				return head(requestedKey);
			});
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					expect(await authorizeProxyRequest(app.request(), d)).toMatchObject({
						kind: 'reject',
						status: resource === 'project' ? 404 : 503,
					});
				}
			} finally {
				failure.mockRestore();
			}
			expect(await authorizeProxyRequest(app.request(), d)).toMatchObject({ kind: 'forward' });
		},
	);

	it.each(['membership', 'project', 'notebook', 'labels'] as const)(
		'revalidates app proxy access immediately after a replica changes %s',
		async (change) => {
			const writer = createServices(bucket);
			await writer.projects.addMember(pid, { user_id: STRANGER }, 'app-user', ACTOR);
			const { d } = recordedDeps(STRANGER);
			const app = await runningApp(writer);
			expect(await authorizeProxyRequest(app.request(), d)).toMatchObject({ kind: 'forward' });
			if (change === 'membership') await writer.projects.removeMember(pid, STRANGER, ACTOR);
			if (change === 'project') await writer.projects.deleteProject(pid, ACTOR);
			if (change === 'notebook') await writer.notebooks.deleteNotebook(pid, app.notebookId, ACTOR);
			if (change === 'labels')
				await writer.notebooks.setSecurityLabels(
					pid,
					app.notebookId,
					{ classification: 'secret', compartments: [] },
					ACTOR,
				);
			expect(await authorizeProxyRequest(app.request(), d)).toMatchObject({
				kind: 'reject',
				status: change === 'membership' ? 403 : 404,
			});
		},
	);

	it('loads project and notebook permissions concurrently after loading the session', async () => {
		const d = deps(ACTOR);
		const session = await d.services.sessions.getSession(pid, sessionId);
		const project = await d.services.projects.getProject(pid);
		const sessionRead = Promise.withResolvers<typeof session>();
		const projectRead = Promise.withResolvers<typeof project>();
		const notebookStarted = Promise.withResolvers<void>();
		vi.spyOn(d.services.sessions, 'getSession').mockReturnValue(sessionRead.promise);
		const projectSpy = vi
			.spyOn(d.services.projects, 'getProject')
			.mockReturnValue(projectRead.promise);
		const notebookSpy = vi
			.spyOn(d.services.notebooks, 'getSecurityLabels')
			.mockImplementation(async () => {
				notebookStarted.resolve();
				return null;
			});
		const decision = authorizeProxyRequest(proxyRequest(), d);
		await vi.waitFor(() => expect(d.services.sessions.getSession).toHaveBeenCalled());
		expect(projectSpy).not.toHaveBeenCalled();
		expect(notebookSpy).not.toHaveBeenCalled();
		sessionRead.resolve(session);
		await notebookStarted.promise;
		expect(projectSpy).toHaveBeenCalledWith(pid, { consistency: 'validated' });
		projectRead.resolve(project);
		expect(await decision).toMatchObject({ kind: 'forward' });
	});

	it.each([true, false])(
		'preserves project error precedence (project fails: %s)',
		async (projectFails) => {
			const d = deps(ACTOR);
			const project = await d.services.projects.getProject(pid);
			const projectRead = Promise.withResolvers<typeof project>();
			const notebookStarted = Promise.withResolvers<void>();
			vi.spyOn(d.services.projects, 'getProject').mockReturnValue(projectRead.promise);
			vi.spyOn(d.services.notebooks, 'getSecurityLabels').mockImplementation(async () => {
				notebookStarted.resolve();
				throw new UnavailableError('Notebook storage unavailable');
			});
			const decision = authorizeProxyRequest(proxyRequest(), d);
			await notebookStarted.promise;
			if (projectFails) projectRead.reject(new Error('Project storage unavailable'));
			else projectRead.resolve(project);
			expect(await decision).toMatchObject({
				kind: 'reject',
				status: projectFails ? 404 : 503,
				message: projectFails ? 'Session not found' : 'Session authorization could not be verified',
			});
		},
	);

	it('returns a project failure without waiting for the notebook read or leaking its rejection', async () => {
		const d = deps(ACTOR);
		const notebookRead = Promise.withResolvers<null>();
		const notebookStarted = Promise.withResolvers<void>();
		vi.spyOn(d.services.projects, 'getProject').mockRejectedValue(
			new NotFoundError('Project missing'),
		);
		vi.spyOn(d.services.notebooks, 'getSecurityLabels').mockImplementation(() => {
			notebookStarted.resolve();
			return notebookRead.promise;
		});
		const settled = vi.fn();
		const decision = authorizeProxyRequest(proxyRequest(), d).then(settled);
		await notebookStarted.promise;
		try {
			await vi.waitFor(() =>
				expect(settled).toHaveBeenCalledWith({
					kind: 'reject',
					status: 404,
					code: 'NOT_FOUND',
					message: 'Session not found',
				}),
			);
		} finally {
			notebookRead.reject(new UnavailableError('Notebook storage unavailable'));
			await decision;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});

	it('masks a missing notebook after the concurrent reads', async () => {
		const d = deps(ACTOR);
		vi.spyOn(d.services.notebooks, 'getSecurityLabels').mockRejectedValue(
			new NotFoundError('Notebook missing'),
		);
		expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
			kind: 'reject',
			status: 404,
			message: 'Session not found',
		});
	});

	it.each(['missing', 'stopped', 'expired', 'unreachable'] as const)(
		'does not read project or notebook permissions for a %s session',
		async (state) => {
			const d = deps(ACTOR);
			const session = await d.services.sessions.getSession(pid, sessionId);
			const sessionSpy = vi.spyOn(d.services.sessions, 'getSession');
			if (state === 'missing') sessionSpy.mockRejectedValue(new NotFoundError('Session missing'));
			else
				sessionSpy.mockResolvedValue({
					...session,
					...(state === 'stopped' ? { status: 'terminated' as const } : {}),
					...(state === 'expired' ? { authorization_expires_at: '2000-01-01T00:00:00.000Z' } : {}),
					...(state === 'unreachable' ? { sandbox_origin_url: undefined } : {}),
				});
			const projectSpy = vi.spyOn(d.services.projects, 'getProject');
			const notebookSpy = vi.spyOn(d.services.notebooks, 'getSecurityLabels');
			expect(await authorizeProxyRequest(proxyRequest(), d)).toMatchObject({
				kind: 'reject',
				status: state === 'missing' ? 404 : state === 'unreachable' ? 503 : 410,
			});
			expect(projectSpy).not.toHaveBeenCalled();
			expect(notebookSpy).not.toHaveBeenCalled();
		},
	);

	it('forwards directly mounted middleware without a dependency context injector', async () => {
		const directDeps = deps(ACTOR);
		directDeps.sandbox.credentialHeaders = ['X-Identity-Assertion'];
		const app = new Hono();
		app.use('*', sandboxProxyMiddleware(directDeps));
		const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('kernel'));
		try {
			const response = await app.request(`https://hub.example.com/proxy/${token}/`, {
				headers: { 'X-Identity-Assertion': 'secret', 'X-Custom': 'retained' },
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('kernel');
			const headers = new Headers(upstream.mock.calls[0][1]?.headers);
			expect(headers.has('x-identity-assertion')).toBe(false);
			expect(headers.get('x-custom')).toBe('retained');
		} finally {
			upstream.mockRestore();
		}
	});

	it('passes through non-proxy paths', async () => {
		const d = await authorizeProxyRequest(req('/api/me'), deps(ACTOR));
		expect(d.kind).toBe('pass');
	});

	it('passes through when proxy mode is not configured (no signing secret)', async () => {
		const d = await authorizeProxyRequest(
			proxyRequest(),
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
		const d = await authorizeProxyRequest(proxyRequest(), deps(null));
		expect(d).toMatchObject({ kind: 'reject', status: 401 });
	});

	it('rejects a caller without project access with 403', async () => {
		const d = await authorizeProxyRequest(proxyRequest(), deps(STRANGER));
		expect(d).toMatchObject({ kind: 'reject', status: 403 });
	});

	it('applies project and action grants to the sandbox proxy', async () => {
		const selectedElsewhere = await authorizeProxyRequest(proxyRequest(), {
			...deps(ACTOR),
			authenticator: authWithGrant({
				actions: '*',
				projects: [ProjectId.parse('proj-0000000000000002')],
			}),
		});
		expect(selectedElsewhere).toMatchObject({ kind: 'reject', status: 404 });

		const missingAction = await authorizeProxyRequest(proxyRequest(), {
			...deps(ACTOR),
			authenticator: authWithGrant({ actions: ['project.read'], projects: [pid] }),
		});
		expect(missingAction).toMatchObject({ kind: 'reject', status: 403 });
	});

	it('rejects a suspended user with 403 and leaves the running session alive', async () => {
		const d = deps(ACTOR);
		await d.services.identities.upsert({ id: ACTOR, email: `${ACTOR}@example.com`, name: 'A' });
		await d.services.identities.setSuspension(ACTOR, true);

		const decision = await authorizeProxyRequest(proxyRequest(), d);
		expect(decision).toMatchObject({ kind: 'reject', status: 403, code: 'USER_SUSPENDED' });
		// The kernel process is not torn down — the session stays running.
		expect((await createServices(bucket).sessions.getSession(pid, sessionId)).status).toBe(
			'running',
		);
	});

	it('fails closed with 503 when suspension status cannot be verified', async () => {
		const d = deps(ACTOR);
		vi.spyOn(d.services.identities, 'isSuspended').mockRejectedValue(new UnavailableError('down'));

		const decision = await authorizeProxyRequest(proxyRequest(), d);
		expect(decision).toMatchObject({ kind: 'reject', status: 503, code: 'SERVICE_UNAVAILABLE' });
	});

	it('forwards a non-member super admin to the kernel', async () => {
		const d = await authorizeProxyRequest(proxyRequest(), {
			...deps(STRANGER),
			policy: { superAdmins: [STRANGER] },
		});
		expect(d.kind).toBe('forward');
	});

	it('masks a labeled project as 404 when the caller has no satisfying context — owner included', async () => {
		const services = createServices(bucket);
		await services.projects.setSecurityLabels(
			pid,
			{ classification: 'SECRET', compartments: ['element-a'] },
			ACTOR,
		);
		const security = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
		// Wired but contextless, and unwired entirely: both fail closed and mask.
		for (const override of [{ resourceSecurity: security }, {}]) {
			const d = await authorizeProxyRequest(proxyRequest(), {
				...deps(ACTOR),
				...override,
			});
			expect(d).toMatchObject({ kind: 'reject', status: 404, message: 'Session not found' });
		}
	});

	it('masks the kernel behind a notebook override the caller does not satisfy', async () => {
		const services = createServices(bucket);
		const notebooks = await services.notebooks.listNotebooks(pid);
		// Project stays unlabeled; only the notebook carries an override.
		await services.notebooks.setSecurityLabels(
			pid,
			notebooks[0].id,
			{ classification: 'SECRET', compartments: ['element-x'] },
			ACTOR,
		);
		const d = await authorizeProxyRequest(proxyRequest(), {
			...deps(ACTOR),
			resourceSecurity: localResourceSecurity(['UNCLASSIFIED', 'SECRET']),
		});
		expect(d).toMatchObject({ kind: 'reject', status: 404, message: 'Session not found' });
	});

	it('tightens the forward deadline to a context expiry earlier than the stored one', async () => {
		const services = createServices(bucket);
		await services.projects.setSecurityLabels(
			pid,
			{ classification: 'SECRET', compartments: [] },
			ACTOR,
		);
		// A session stamped with a FAR deadline at start...
		const notebooks = await services.notebooks.listNotebooks(pid);
		const far = await services.sessions.createSession({
			notebook_id: notebooks[0].id,
			project_id: pid,
			user_id: ACTOR,
			authorization_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		});
		await services.sessions.setRunning(pid, far.session_id, '/proxy/x/', false, ORIGIN);
		const farToken = await signProxyToken(pid, far.session_id, SECRET);
		// ...whose subject context now expires much sooner.
		const contextExpiry = new Date(Date.now() + 60_000).toISOString();
		const d = await authorizeProxyRequest(req(`/proxy/${farToken}/`), {
			...deps(ACTOR),
			resourceSecurity: localResourceSecurity(
				['UNCLASSIFIED', 'SECRET'],
				makeSubjectContext({ compartments: [], expiresAt: contextExpiry }),
			),
		});
		expect(d).toMatchObject({ kind: 'forward' });
		// The CURRENT context expiry wins over the deadline stamped at start.
		expect((d as { authorizationDeadline?: number }).authorizationDeadline).toBe(
			Date.parse(contextExpiry),
		);
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

		it('admits app users only to apps under every viewer mode', async () => {
			for (const viewerMode of ['static', 'applications', 'ephemeral-sandbox'] as const) {
				const appDeps = {
					...deps(STRANGER),
					policy: { defaultRole: 'app-user' as const, viewerMode },
				};
				expect((await authorizeProxyRequest(req(`/proxy/${appToken}/`), appDeps)).kind).toBe(
					'forward',
				);
				expect(await authorizeProxyRequest(proxyRequest(), appDeps)).toMatchObject({
					kind: 'reject',
					status: 403,
				});
			}
		});

		it.each(['app-user', 'viewer', 'editor'] as const)(
			'masks deleted notebook kernels for %s',
			async (defaultRole) => {
				const services = createServices(bucket);
				const [notebook] = await services.notebooks.listNotebooks(pid);
				await services.notebooks.deleteNotebook(pid, notebook.id, ACTOR);
				const decision = await authorizeProxyRequest(req(`/proxy/${appToken}/`), {
					...deps(STRANGER),
					policy: { defaultRole, viewerMode: 'applications' },
				});
				expect(decision).toMatchObject({ kind: 'reject', status: 404 });
			},
		);

		it('rejects a viewer from the app kernel under `static` (and when unset)', async () => {
			for (const dep of [viewerDeps('static'), viewerDeps()]) {
				const d = await authorizeProxyRequest(req(`/proxy/${appToken}/`), dep);
				expect(d).toMatchObject({ kind: 'reject', status: 403 });
			}
		});

		it('never admits a viewer to another user’s EDIT kernel, whatever the viewer mode', async () => {
			const d = await authorizeProxyRequest(proxyRequest(), viewerDeps('ephemeral-sandbox'));
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
		const d = await authorizeProxyRequest(proxyRequest('/assets/app.js?v=1'), deps(ACTOR));
		expect(d).toMatchObject({
			kind: 'forward',
			targetUrl: `${ORIGIN}/proxy/${token}/assets/app.js?v=1`,
			sessionId,
			kernelAuthToken: TEST_KERNEL_AUTH_TOKEN,
		});
	});

	it('forwards legacy tokenless sessions without a kernel credential', async () => {
		const services = createServices(bucket);
		const current = await services.sessions.getSession(pid, sessionId);
		const legacy = await services.sessions.createSession({
			notebook_id: current.notebook_id,
			project_id: pid,
			user_id: ACTOR,
		});
		await services.sessions.setRunning(pid, legacy.session_id, '/proxy/legacy/', false, ORIGIN);
		const legacyProxyToken = await signProxyToken(pid, legacy.session_id, SECRET);

		const allowed = await authorizeProxyRequest(req(`/proxy/${legacyProxyToken}/`), deps(ACTOR));

		expect(allowed).toMatchObject({ kind: 'forward', sessionId: legacy.session_id });
		expect(allowed).not.toHaveProperty('kernelAuthToken');
	});

	it('authorizes a VS Code surface separately and strips the code-server proxy prefix', async () => {
		const services = createServices(bucket);
		await services.sessions.setSurfaceState(pid, sessionId, 'vscode', {
			status: 'ready',
			origin_url: 'http://vscode.internal:8443',
		});

		const path = `/surface-proxy/${token}/vscode/stable/out.js?v=1`;
		const allowed = await authorizeProxyRequest(req(path), deps(ACTOR));
		expect(allowed).toMatchObject({
			kind: 'forward',
			targetUrl: 'http://vscode.internal:8443/stable/out.js?v=1',
			sessionId,
		});
		expect(allowed).not.toHaveProperty('kernelAuthToken');

		const denied = await authorizeProxyRequest(req(path), {
			...deps(STRANGER),
			policy: { defaultRole: 'viewer' },
		});
		expect(denied).toMatchObject({ kind: 'reject', status: 403 });
	});

	it('maps the code-server surface root to the upstream root and preserves its query', async () => {
		const services = createServices(bucket);
		await services.sessions.setSurfaceState(pid, sessionId, 'vscode', {
			status: 'ready',
			origin_url: 'http://vscode.internal:8443',
		});
		const path = `/surface-proxy/${token}/vscode/?folder=%2Fworkspace`;

		const allowed = await authorizeProxyRequest(req(path), deps(ACTOR));

		expect(allowed).toMatchObject({
			kind: 'forward',
			targetUrl: 'http://vscode.internal:8443/?folder=%2Fworkspace',
		});
	});

	it.each(['starting', 'failed', 'stopped'] as const)(
		'rejects a %s VS Code surface before forwarding',
		async (status) => {
			await createServices(bucket).sessions.setSurfaceState(pid, sessionId, 'vscode', {
				status,
				origin_url: 'http://vscode.internal:8443',
			});

			const decision = await authorizeProxyRequest(
				req(`/surface-proxy/${token}/vscode/`),
				deps(ACTOR),
			);

			expect(decision).toMatchObject({
				kind: 'reject',
				status: 503,
				code: 'SERVICE_UNAVAILABLE',
				message: 'Session surface is not reachable via the proxy',
			});
		},
	);

	it('preserves the proxy prefix configured as the OpenVSCode server base path', async () => {
		const services = createServices(bucket);
		await services.sessions.setSurfaceState(pid, sessionId, 'vscode', {
			status: 'ready',
			origin_url: 'http://vscode.internal:8443',
		});
		const configured = deps(ACTOR);
		configured.sandbox.surfaces = {
			vscode: {
				flavor: 'openvscode',
				start: 'on-demand',
				port: 8443,
				settings: {},
				extensionGallery: 'openvsx',
				embed: 'tab',
			},
		};
		const path = `/surface-proxy/${token}/vscode/stable/out.js?v=1`;

		const allowed = await authorizeProxyRequest(req(path), configured);

		expect(allowed).toMatchObject({
			kind: 'forward',
			targetUrl: `http://vscode.internal:8443${path}`,
		});
	});

	it.each([
		{
			persisted: 'strip-prefix' as const,
			configured: 'openvscode' as const,
			expectedPath: '/stable/out.js?v=1',
		},
		{
			persisted: 'preserve-prefix' as const,
			configured: 'code-server' as const,
			expectedPath: 'preserve',
		},
	])('uses persisted $persisted routing during a change to $configured', async (testCase) => {
		const services = createServices(bucket);
		await services.sessions.setSurfaceState(pid, sessionId, 'vscode', {
			status: 'ready',
			origin_url: 'http://vscode.internal:8443',
			proxy_path: testCase.persisted,
		});
		const configured = deps(ACTOR);
		configured.sandbox.surfaces = {
			vscode: {
				flavor: testCase.configured,
				start: 'on-demand',
				port: 8443,
				settings: {},
				extensionGallery: 'openvsx',
				embed: 'tab',
			},
		};

		const allowed = await authorizeProxyRequest(
			req(`/surface-proxy/${token}/vscode/stable/out.js?v=1`),
			configured,
		);

		const expectedPath =
			testCase.expectedPath === 'preserve'
				? `/surface-proxy/${token}/vscode/stable/out.js?v=1`
				: testCase.expectedPath;
		expect(allowed).toMatchObject({
			kind: 'forward',
			targetUrl: `http://vscode.internal:8443${expectedPath}`,
		});
	});

	it('strips the prefix for any surface whose persisted routing says so', async () => {
		await createServices(bucket).sessions.setSurfaceState(pid, sessionId, 'opencode', {
			status: 'ready',
			origin_url: 'http://opencode.internal:4096',
			proxy_path: 'strip-prefix',
		});

		const allowed = await authorizeProxyRequest(
			req(`/surface-proxy/${token}/opencode/global/health?x=1`),
			deps(ACTOR),
		);

		expect(allowed).toMatchObject({
			kind: 'forward',
			targetUrl: 'http://opencode.internal:4096/global/health?x=1',
		});
	});

	it('rejects a terminated session with 410', async () => {
		await createServices(bucket).sessions.terminate(pid, sessionId);
		const d = await authorizeProxyRequest(proxyRequest(), deps(ACTOR));
		expect(d).toMatchObject({ kind: 'reject', status: 410 });
	});

	it('rejects a running kernel after its non-extendable authorization deadline', async () => {
		const services = createServices(bucket);
		const notebooks = await services.notebooks.listNotebooks(pid);
		const expired = await services.sessions.createSession({
			notebook_id: notebooks[0].id,
			project_id: pid,
			user_id: ACTOR,
			authorization_expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		await services.sessions.setRunning(pid, expired.session_id, '/proxy/x/', false, ORIGIN);
		const expiredToken = await signProxyToken(pid, expired.session_id, SECRET);

		const d = await authorizeProxyRequest(req(`/proxy/${expiredToken}/`), deps(ACTOR));

		expect(d).toMatchObject({
			kind: 'reject',
			status: 410,
			code: 'GONE',
			message: 'Session authorization has expired',
		});
	});

	it('allows requests before the authorization deadline and rejects the same session after it', async () => {
		const now = Date.now();
		const deadline = now + 60_000;
		const services = createServices(bucket);
		const notebooks = await services.notebooks.listNotebooks(pid);
		const expiring = await services.sessions.createSession({
			notebook_id: notebooks[0].id,
			project_id: pid,
			user_id: ACTOR,
			authorization_expires_at: new Date(deadline).toISOString(),
		});
		await services.sessions.setRunning(pid, expiring.session_id, '/proxy/x/', false, ORIGIN);
		const expiringToken = await signProxyToken(pid, expiring.session_id, SECRET);
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

		try {
			const before = await authorizeProxyRequest(
				req(`/proxy/${expiringToken}/notebook`),
				deps(ACTOR),
			);
			expect(before).toMatchObject({
				kind: 'forward',
				sessionId: expiring.session_id,
				authorizationDeadline: deadline,
			});

			nowSpy.mockReturnValue(deadline);
			const after = await authorizeProxyRequest(
				req(`/proxy/${expiringToken}/notebook`),
				deps(ACTOR),
			);
			expect(after).toMatchObject({
				kind: 'reject',
				status: 410,
				code: 'GONE',
				message: 'Session authorization has expired',
			});
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('rejects a session whose project was soft-deleted', async () => {
		// Deleting a project must cut kernel access immediately — the sandbox may
		// still be alive, and in proxy mode this is the only gate in its path.
		await createServices(bucket).projects.deleteProject(pid, ACTOR);
		const d = await authorizeProxyRequest(proxyRequest(), deps(ACTOR));
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
	let flakyHits: number;
	let flakyAuthorizations: (string | undefined)[];

	beforeEach(() => {
		flakyHits = 0;
		flakyAuthorizations = [];
	});

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === '/flaky') {
				// First connection dies mid-request (a closed keep-alive socket, from
				// the client's perspective); subsequent attempts succeed.
				flakyHits++;
				flakyAuthorizations.push(req.headers.authorization);
				if (flakyHits === 1) {
					req.socket.destroy();
					return;
				}
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end('recovered');
				return;
			}
			if (req.url === '/badgateway') {
				res.writeHead(502, { 'content-type': 'text/plain' });
				res.end('upstream ingress says no');
				return;
			}
			if (req.url === '/setcookie') {
				res.writeHead(200, {
					'set-cookie': 'mh_session=attacker; Path=/',
					'x-marimohub-app-status': 'starting',
					'x-marimohub-app-proxy': 'spoof',
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

	it('returns 502 and logs a structured event when the kernel is unreachable', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		// A deterministic dead endpoint: a server we keep listening (so no other
		// process can grab the port) that kills every connection on accept.
		const dead = createServer();
		dead.on('connection', (socket) => socket.destroy());
		await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
		const deadOrigin = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
		try {
			const res = await forwardHttp(
				new Request('https://hub/x'),
				`${deadOrigin}/proxy/tok/down`,
				'sess-123',
				TEST_KERNEL_AUTH_TOKEN,
			);
			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({
				success: false,
				error: { code: 'SERVICE_UNAVAILABLE', message: 'Kernel unavailable' },
			});

			const events = logSpy.mock.calls
				.map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
				.filter((e) => e.event === 'sandbox_proxy_upstream_error');
			// GET → one retry → two logged attempts, both failed.
			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({
				level: 'warn',
				session_id: 'sess-123',
				method: 'GET',
				target: deadOrigin,
				attempt: 1,
				will_retry: true,
			});
			expect(events[1]).toMatchObject({ attempt: 2, will_retry: false });
			for (const e of events) {
				// A diagnostic code survives on the fetch error's cause (which exact
				// code — ECONNRESET vs UND_ERR_SOCKET — depends on RST timing, so the
				// precise-code property is pinned in log.test.ts instead)…
				const error = e.error as { error_name: string; cause?: { error_code?: unknown } };
				expect(error.error_name).toBe('TypeError');
				expect(typeof error.cause?.error_code).toBe('string');
				// …but never free-form error text: no message/stack that could quote
				// the token-bearing target URL, and no token.
				const line = JSON.stringify(e);
				expect(line).not.toContain('/proxy/tok');
				expect(line).not.toContain(TEST_KERNEL_AUTH_TOKEN);
				expect(line).not.toContain('fetch failed');
			}
		} finally {
			logSpy.mockRestore();
			await new Promise<void>((resolve) => dead.close(() => resolve()));
		}
	});

	it('keeps kernel authentication on a retried GET', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const res = await forwardHttp(
				new Request('https://hub/x'),
				`${origin}/flaky`,
				'sess-123',
				TEST_KERNEL_AUTH_TOKEN,
			);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('recovered');
			expect(flakyHits).toBe(2);
			expect(flakyAuthorizations).toEqual([
				`Bearer ${TEST_KERNEL_AUTH_TOKEN}`,
				`Bearer ${TEST_KERNEL_AUTH_TOKEN}`,
			]);
		} finally {
			logSpy.mockRestore();
		}
	});

	it('does not retry a request with a body', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const res = await forwardHttp(
				new Request('https://hub/x', { method: 'POST', body: 'cell code' }),
				`${origin}/flaky`,
			);
			expect(res.status).toBe(502);
			expect(flakyHits).toBe(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it('passes an upstream gateway status through verbatim and logs it', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const res = await forwardHttp(
				new Request('https://hub/x'),
				`${origin}/badgateway`,
				'sess-123',
			);
			expect(res.status).toBe(502);
			expect(await res.text()).toBe('upstream ingress says no');

			const events = logSpy.mock.calls
				.map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
				.filter((e) => e.event === 'sandbox_proxy_upstream_gateway_status');
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				level: 'warn',
				session_id: 'sess-123',
				status: 502,
				target: origin,
			});
		} finally {
			logSpy.mockRestore();
		}
	});

	it('replaces hub credentials with the kernel token before forwarding', async () => {
		// Notebook code can read request headers (mo.app_meta().request) — the
		// caller's hub session cookie / PAT / Access assertion must never reach it.
		const req = new Request('https://hub.example.com/proxy/tok/api', {
			headers: {
				cookie: 'hub_session=secret',
				authorization: 'Bearer mhub_pat_secret',
				'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.access.jwt',
				'cf-access-client-id': 'svc.access',
				'cf-access-client-secret': 'svc-secret',
				'X-Goog-IAP-JWT-Assertion': 'iap-proof',
				'X-Custom-Assertion': 'custom-proof',
				'x-custom': 'passes',
				'x-marimohub-app-visit-id': 'visit-secret',
				'x-marimohub-app-generation': 'generation-secret',
			},
		});
		const res = await forwardHttp(req, `${origin}/echo`, 'sess-123', TEST_KERNEL_AUTH_TOKEN, [
			'x-CUSTOM-assertion',
		]);
		const seen = (await res.json()) as Record<string, string>;
		expect(seen.cookie).toBeUndefined();
		expect(seen.authorization).toBe(`Bearer ${TEST_KERNEL_AUTH_TOKEN}`);
		expect(seen['cf-access-jwt-assertion']).toBeUndefined();
		expect(seen['cf-access-client-id']).toBeUndefined();
		expect(seen['cf-access-client-secret']).toBeUndefined();
		expect(seen['x-goog-iap-jwt-assertion']).toBeUndefined();
		expect(seen['x-custom-assertion']).toBeUndefined();
		expect(seen['x-custom']).toBe('passes');
		expect(seen['x-marimohub-app-visit-id']).toBeUndefined();
		expect(seen['x-marimohub-app-generation']).toBeUndefined();
	});

	it.each([undefined, [], ['AUTHORIZATION', 'X-Custom-Identity', 'x-custom-identity']])(
		'strips default credentials independently of extra header configuration: %j',
		async (headers) => {
			const request = new Request('https://hub/x', {
				headers: {
					Authorization: 'Bearer hub-secret',
					'X-Forwarded-Email': 'private@example.com',
					'X-Forwarded-User': 'private-user',
					'X-Goog-Iap-Jwt-Assertion': 'iap-secret',
					'X-Custom-Identity': 'custom-secret',
					'X-Request-Id': 'request-123',
				},
			});
			const res = await forwardHttp(
				request,
				`${origin}/echo`,
				undefined,
				TEST_KERNEL_AUTH_TOKEN,
				headers,
			);
			const seen = (await res.json()) as Record<string, string>;
			expect(seen.authorization).toBe(`Bearer ${TEST_KERNEL_AUTH_TOKEN}`);
			for (const header of ['x-forwarded-email', 'x-forwarded-user', 'x-goog-iap-jwt-assertion'])
				expect(seen[header]).toBeUndefined();
			expect(seen['x-custom-identity']).toBe(headers?.length ? undefined : 'custom-secret');
			expect(seen['x-request-id']).toBe('request-123');
		},
	);

	it('forwards no authorization header for a legacy tokenless session', async () => {
		const res = await forwardHttp(new Request('https://hub/x'), `${origin}/echo`);
		const seen = (await res.json()) as Record<string, string>;
		expect(seen.authorization).toBeUndefined();
	});

	it('strips Set-Cookie from the kernel response', async () => {
		// In proxy mode a kernel cookie is written for the hub's own origin, so a
		// notebook could overwrite the caller's hub session.
		const res = await forwardHttp(new Request('https://hub/x'), `${origin}/setcookie`);
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(res.headers.get('x-marimohub-app-status')).toBeNull();
		expect(res.headers.get('x-marimohub-app-proxy')).toBeNull();
		expect(await res.text()).toBe('ok');
	});
});

describe('create-session in proxy mode', () => {
	it.each(['on', 'off'] as const)(
		'auth %s: returns a proxy URL and persists the origin off-response',
		async (auth) => {
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
					auth,
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					exposure: new ProxyExposure(SECRET),
					appBaseUrl: 'https://hub.example.com/marimohub',
				},
			});
			const app = createApi(deps);

			const res = await app.request(`/api/v1/projects/${pid}/notebooks/${notebook.id}/sessions`, {
				method: 'POST',
			});
			expect(res.status).toBe(200);
			const { data } = (await res.json()) as { data: { session_id: string; sandbox_url: string } };

			const token = await signProxyToken(pid, data.session_id as never, SECRET);
			expect(data.sandbox_url).toBe(`https://hub.example.com/marimohub/proxy/${token}/`);
			// The server-reachable origin is persisted on the record but never in the response.
			expect(data).not.toHaveProperty('sandbox_origin_url');
			expect(data).not.toHaveProperty('kernel_auth_token');
			const stored = await services.sessions.getSession(pid, data.session_id as never);
			expect(stored.sandbox_origin_url).toBe('https://sandbox.example/kernel');
			if (auth === 'on') expect(stored.kernel_auth_token).toMatch(KERNEL_AUTH_TOKEN_PATTERN);
			else expect(stored.kernel_auth_token).toBeUndefined();
		},
	);
});
