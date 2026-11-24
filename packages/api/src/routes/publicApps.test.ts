import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	DEFAULT_APP_POOL_POLICY,
	Millis,
	ProxyExposure,
	sessionAudience,
} from '@marimo-hub/core';
import type { DeepLink, ProjectIntegrationsService } from '@marimo-hub/core';
import {
	ACTOR,
	localResourceSecurity,
	makeFakeCompute,
	makeSubjectContext,
	uid,
} from '@marimo-hub/core/testing';
import type { PublicAppsConfig } from '../context';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { PUBLIC_VISIT_COOKIE_NAME, PUBLIC_VISIT_TOKEN_HEADER } from './publicApps';
import { authorizeProxyRequest } from '../sandboxProxy';
import { sweepAppPools } from '../appPools';

const PUBLIC_SECRET = 'test-public-app-links-signing-secret-32-bytes!';
const PROXY_SECRET = 'test-proxy-signing-secret-at-least-32-bytes-long!';

function makePublicConfig(overrides: Partial<PublicAppsConfig> = {}): PublicAppsConfig {
	return {
		signingSecret: PUBLIC_SECRET,
		allowProjectIntegrations: false,
		maxConcurrentSessions: 5,
		poolPolicy: {
			...DEFAULT_APP_POOL_POLICY,
			maxSessionsPerVersion: 2,
			maxVisitsPerSession: 5,
			idleMs: Millis.of(300_000),
		},
		idleTimeoutMs: Millis.of(300_000),
		maxLifetimeMs: Millis.of(3_600_000),
		visitTokenTtlSeconds: 600,
		...overrides,
	};
}

function extractCookieValue(res: Response, name: string): string | undefined {
	const header = res.headers.get('set-cookie');
	if (!header) return undefined;
	const match = new RegExp(`${name}=([^;]+)`).exec(header);
	return match?.[1];
}

async function setupProjectAndNotebook() {
	const bucket = await createInitializedBucket();
	const services = createServices(bucket);
	const project = await services.projects.createProject(
		{ name: 'Public Demo', description: '' },
		ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Sales Dashboard', description: '', code: 'import marimo' },
		ACTOR,
	);
	return { bucket, services, project, notebook };
}

afterEach(() => vi.restoreAllMocks());

describe('Public app links', () => {
	it('returns uniform 404 when gate is off, link is private, or slug is missing', async () => {
		const { bucket, project, notebook } = await setupProjectAndNotebook();
		const manager = createTestApi({ bucket });
		const base = `/projects/${project.id}/notebooks/${notebook.id}/deep-links`;
		const link = await expectOk<DeepLink>(await manager.request('POST', base, { slug: 'sales' }));

		// Enabling fails with 422 while deployment gate is off.
		await expectError(
			await manager.request('PATCH', `${base}/sales`, {
				registration_id: link.registration_id,
				access: { mode: 'public' },
			}),
			422,
		);

		const anonGateOff = createTestApi({
			bucket,
			deps: { authenticator: { authenticate: async () => null } },
		});
		expect((await anonGateOff.app.request('/api/public/v1/apps/sales')).status).toBe(404);
		expect((await anonGateOff.app.request('/api/public/v1/apps/does-not-exist')).status).toBe(404);

		// With gate on, private link still returns uniform 404.
		const anonGateOn = createTestApi({
			bucket,
			deps: {
				authenticator: { authenticate: async () => null },
				publicApps: makePublicConfig(),
			},
		});
		const privateRes = await anonGateOn.app.request('/api/public/v1/apps/sales');
		const missingRes = await anonGateOn.app.request('/api/public/v1/apps/does-not-exist');
		expect(privateRes.status).toBe(404);
		expect(missingRes.status).toBe(404);
		expect(await privateRes.json()).toEqual(await missingRes.json());
	});

	it('enforces session-only enable, manager role, multi-segment slugs, strict hub isolation, and hard revocation', async () => {
		const { bucket, services, project, notebook } = await setupProjectAndNotebook();
		const publicApps = makePublicConfig();
		const manager = createTestApi({ bucket, deps: { publicApps } });
		const base = `/projects/${project.id}/notebooks/${notebook.id}/deep-links`;

		// Multi-segment slug colliding with `/visits/current` must work unambiguously!
		const slug = 'a/visits/current';
		const link = await expectOk<DeepLink>(await manager.request('POST', base, { slug }));

		// PAT callers cannot enable public access (SESSION_ONLY_SECURITY).
		const patManager = createTestApi({
			bucket,
			deps: {
				publicApps,
				authenticator: {
					authenticate: async () => ({
						id: ACTOR,
						email: 'actor@test.local',
						credential: { kind: 'personal-access-token' },
					}),
				},
			},
		});
		await expectError(
			await patManager.request('PATCH', `${base}/${slug}`, {
				registration_id: link.registration_id,
				access: { mode: 'public' },
			}),
			403,
		);

		// Non-manager (editor) cannot publish.
		const editorId = uid('editor');
		await services.projects.addMember(project.id, { user_id: editorId }, 'editor', ACTOR);
		const editorApi = createTestApi({ bucket, userId: editorId, deps: { publicApps } });
		await expectError(
			await editorApi.request('PATCH', `${base}/${slug}`, {
				registration_id: link.registration_id,
				access: { mode: 'public' },
			}),
			403,
		);

		// Manager enables public access over interactive session.
		const published = await expectOk<DeepLink>(
			await manager.request('PATCH', `${base}/${slug}`, {
				registration_id: link.registration_id,
				access: { mode: 'public' },
			}),
		);
		expect(published.access.mode).toBe('public');
		expect(published.access.grant_id).toBeTruthy();

		// Anonymous visitor resolves and starts a visit in proxy mode.
		const proxyExposure = new ProxyExposure(PROXY_SECRET);
		const compute = makeFakeCompute();
		const anon = createTestApi({
			bucket,
			compute,
			deps: {
				authenticator: { authenticate: async () => null },
				publicApps,
				sandbox: {
					...manager.deps.sandbox,
					exposure: proxyExposure,
					appBaseUrl: 'https://hub.example.com',
				},
			},
		});

		const resolveRes = await anon.app.request(`/api/public/v1/apps/${slug}`);
		expect(resolveRes.status).toBe(200);
		expect(resolveRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(resolveRes.headers.get('cache-control')).toBe('no-store');
		const resolved = (await resolveRes.json()) as {
			success: true;
			data: Record<string, unknown>;
		};
		expect(resolved.data.title).toBe('Sales Dashboard');
		expect(resolved.data.slug).toBe(slug);
		// Must never leak internal identifiers.
		expect(JSON.stringify(resolved)).not.toContain(project.id);
		expect(JSON.stringify(resolved)).not.toContain(notebook.id);

		// Cross-origin POST is rejected by CSRF guard.
		const csrfRes = await anon.app.request('/api/public/v1/visits', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://evil.example.net',
				'Sec-Fetch-Site': 'cross-site',
			},
			body: JSON.stringify({ slug }),
		});
		expect(csrfRes.status).toBe(403);

		// Start public visit.
		const startRes = await anon.app.request('/api/public/v1/visits', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug }),
		});
		expect(startRes.status).toBe(200);
		const visitBody = (await startRes.json()) as {
			success: true;
			data: {
				slug: string;
				status: string;
				sandbox_url: string | null;
				visit_token: string;
			};
		};
		expect(visitBody.data.status).toBe('running');
		expect(visitBody.data.sandbox_url).toContain('.pub.');
		expect(visitBody.data.visit_token.startsWith('v1.')).toBe(true);
		const cookieValue = extractCookieValue(startRes, PUBLIC_VISIT_COOKIE_NAME);
		expect(cookieValue).toBe(visitBody.data.visit_token);

		// Visit token MUST NOT grant access to any authenticated `/api/v1/*` route.
		const meRes = await anon.app.request('/api/v1/me', {
			headers: {
				[PUBLIC_VISIT_TOKEN_HEADER]: visitBody.data.visit_token,
				Authorization: `Bearer ${visitBody.data.visit_token}`,
				Cookie: `${PUBLIC_VISIT_COOKIE_NAME}=${visitBody.data.visit_token}`,
			},
		});
		expect(meRes.status).toBe(401);
		const projectsRes = await anon.app.request(
			`/api/v1/projects/${project.id}/notebooks/${notebook.id}`,
			{
				headers: {
					[PUBLIC_VISIT_TOKEN_HEADER]: visitBody.data.visit_token,
					Cookie: `${PUBLIC_VISIT_COOKIE_NAME}=${visitBody.data.visit_token}`,
				},
			},
		);
		expect(projectsRes.status).toBe(401);

		// Proxy request succeeds with cookie, fails without cookie, and rejects /surface-proxy/*.
		const sandboxPath = new URL(visitBody.data.sandbox_url!).pathname;
		const proxyOk = await authorizeProxyRequest(
			new Request(`https://hub.example.com${sandboxPath}`, {
				headers: { Cookie: `${PUBLIC_VISIT_COOKIE_NAME}=${cookieValue}` },
			}),
			anon.deps,
		);
		expect(proxyOk.kind).toBe('forward');

		const proxyNoCookie = await authorizeProxyRequest(
			new Request(`https://hub.example.com${sandboxPath}`),
			anon.deps,
		);
		expect(proxyNoCookie.kind).toBe('reject');

		const proxyToken = (sandboxPath.split('/proxy/')[1] ?? '').replace(/\/$/, '');
		const surfaceReject = await authorizeProxyRequest(
			new Request(`https://hub.example.com/surface-proxy/${proxyToken}/vscode/`, {
				headers: { Cookie: `${PUBLIC_VISIT_COOKIE_NAME}=${cookieValue}` },
			}),
			anon.deps,
		);
		expect(surfaceReject).toMatchObject({ kind: 'reject', status: 403 });

		// Heartbeat succeeds with X-MH-Visit-Token.
		const hbRes = await anon.app.request('/api/public/v1/visits/heartbeat', {
			method: 'POST',
			headers: { [PUBLIC_VISIT_TOKEN_HEADER]: visitBody.data.visit_token },
		});
		expect(hbRes.status).toBe(200);

		// Verify public session was created with audience: 'public' and does not count toward member project cap.
		const projectApps = await services.sessions.listActiveAppsForProject(project.id);
		expect(projectApps).toHaveLength(0);
		const publicSessions = await services.sessions.listActivePublicApps();
		expect(publicSessions).toHaveLength(1);
		expect(sessionAudience(publicSessions[0])).toBe('public');

		// Disable works even when deployment gate is turned off, and immediately destroys live public sandbox!
		const managerGateOff = createTestApi({ bucket, compute });
		const disabled = await expectOk<DeepLink>(
			await managerGateOff.request('PATCH', `${base}/${slug}`, {
				registration_id: link.registration_id,
				access: { mode: 'inherit' },
			}),
		);
		expect(disabled.access).toEqual({ mode: 'inherit' });

		// Old token & proxy cookie immediately fail.
		const hbAfterRevoke = await anon.app.request('/api/public/v1/visits/heartbeat', {
			method: 'POST',
			headers: { [PUBLIC_VISIT_TOKEN_HEADER]: visitBody.data.visit_token },
		});
		expect(hbAfterRevoke.status).toBe(404);
		const proxyAfterRevoke = await authorizeProxyRequest(
			new Request(`https://hub.example.com${sandboxPath}`, {
				headers: { Cookie: `${PUBLIC_VISIT_COOKIE_NAME}=${cookieValue}` },
			}),
			anon.deps,
		);
		expect(proxyAfterRevoke.kind).toBe('reject');

		// Re-enabling rotates grant_id so old tokens are never revived.
		const republished = await expectOk<DeepLink>(
			await manager.request('PATCH', `${base}/${slug}`, {
				registration_id: link.registration_id,
				access: { mode: 'public' },
			}),
		);
		expect(republished.access.grant_id).not.toBe(published.access.grant_id);
		const hbOldTokenAfterRepublish = await anon.app.request('/api/public/v1/visits/heartbeat', {
			method: 'POST',
			headers: { [PUBLIC_VISIT_TOKEN_HEADER]: visitBody.data.visit_token },
		});
		expect(hbOldTokenAfterRepublish.status).toBe(404);
	});

	it('passes project-only integration scope only when double-opted-in (Option A)', async () => {
		const { bucket, project, notebook } = await setupProjectAndNotebook();
		const resolveForSession = vi.fn(async () => ({
			files: [],
			vars: { BQ_PROJECT: 'demo' },
			attachments: [],
			warnings: [],
		}));
		const integrations = { resolveForSession } as unknown as ProjectIntegrationsService;
		const publicApps = makePublicConfig({ allowProjectIntegrations: true });
		const manager = createTestApi({ bucket, deps: { publicApps, integrations } });
		const anon = createTestApi({
			bucket,
			compute: makeFakeCompute(),
			deps: {
				authenticator: { authenticate: async () => null },
				publicApps,
				integrations,
			},
		});
		const base = `/projects/${project.id}/notebooks/${notebook.id}/deep-links`;

		// Link 1: credential-free (default)
		const plain = await expectOk<DeepLink>(await manager.request('POST', base, { slug: 'plain' }));
		await expectOk<DeepLink>(
			await manager.request('PATCH', `${base}/plain`, {
				registration_id: plain.registration_id,
				access: { mode: 'public' },
			}),
		);
		const plainStart = await anon.app.request('/api/public/v1/visits', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'plain' }),
		});
		expect(plainStart.status).toBe(200);
		expect(resolveForSession).not.toHaveBeenCalled();

		// Link 2: opted into project-scoped integrations (isolated pool, scope: 'project-only')
		const bq = await expectOk<DeepLink>(await manager.request('POST', base, { slug: 'bq-demo' }));
		await expectOk<DeepLink>(
			await manager.request('PATCH', `${base}/bq-demo`, {
				registration_id: bq.registration_id,
				access: { mode: 'public', allow_project_integrations: true },
			}),
		);
		const bqStart = await anon.app.request('/api/public/v1/visits', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'bq-demo' }),
		});
		expect(bqStart.status).toBe(200);
		expect(resolveForSession).toHaveBeenCalledOnce();
		const callArgs = resolveForSession.mock.calls[0] as unknown[];
		const callCtx = callArgs[1] as {
			scope?: string;
			resolveFederatedCredentials?: unknown;
		};
		expect(callCtx.scope).toBe('project-only');
		expect(callCtx.resolveFederatedCredentials).toBeUndefined();
	});

	it('downgrades public links and retires public sandboxes when security labels are added', async () => {
		const { bucket, services, project, notebook } = await setupProjectAndNotebook();
		const publicApps = makePublicConfig();
		const compute = makeFakeCompute();
		const resourceSecurity = localResourceSecurity(
			['public', 'internal', 'restricted'],
			makeSubjectContext({ classification: 'restricted', compartments: ['finance'] }),
		);
		const superAdmin = createTestApi({
			bucket,
			compute,
			deps: {
				publicApps,
				resourceSecurity,
				policy: { superAdmins: [`${ACTOR}@example.com`] },
			},
		});
		const anon = createTestApi({
			bucket,
			compute,
			deps: {
				authenticator: { authenticate: async () => null },
				publicApps,
				resourceSecurity,
			},
		});
		const base = `/projects/${project.id}/notebooks/${notebook.id}/deep-links`;
		const link = await expectOk<DeepLink>(await superAdmin.request('POST', base, { slug: 'kpi' }));
		await expectOk<DeepLink>(
			await superAdmin.request('PATCH', `${base}/kpi`, {
				registration_id: link.registration_id,
				access: { mode: 'public' },
			}),
		);
		const startRes = await anon.app.request('/api/public/v1/visits', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: 'kpi' }),
		});
		expect(startRes.status).toBe(200);
		expect(await services.sessions.listActivePublicApps()).toHaveLength(1);

		// Adding a security label to the notebook downgrades the link and terminates the public sandbox.
		await expectOk(
			await superAdmin.request(
				'PUT',
				`/projects/${project.id}/notebooks/${notebook.id}/security-labels`,
				{
					classification: 'restricted',
					compartments: ['finance'],
				},
			),
		);
		const updatedLink = await services.deepLinks.resolve('kpi');
		expect(updatedLink.access).toEqual({ mode: 'inherit' });
		expect((await anon.app.request('/api/public/v1/apps/kpi')).status).toBe(404);
		await sweepAppPools(anon.deps);
		expect(await services.sessions.listActivePublicApps()).toHaveLength(0);
	});
});
