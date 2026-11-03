import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, SandboxId, UserId } from '@marimo-hub/core';
import {
	ACTOR,
	MemoryNotifier,
	localResourceSecurity,
	makeFakeCompute,
} from '@marimo-hub/core/testing';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { createTestApi, expectError, expectOk } from '../testing';
import type { TestApiOptions } from '../testing';

const CONTEXT = {
	page_url: 'https://user:password@hub.example/apps?token=secret#private',
	client: { user_agent: 'test browser', viewport: { width: 1024, height: 768 } },
};
const REPORT = { ...CONTEXT, message: 'The app did not start' };

function setup() {
	const notifier = new MemoryNotifier();
	const api = createTestApi({
		deps: { notifier, supportReports: true, version: { version: '1.2.3' } },
	});
	return { ...api, notifier };
}

/** Another caller on the same bucket and notifier. */
function as(
	api: ReturnType<typeof setup>,
	options: Pick<TestApiOptions, 'userId' | 'subject' | 'deps'> = {},
) {
	return createTestApi({
		...options,
		bucket: api.bucket,
		deps: { notifier: api.notifier, supportReports: true, ...options.deps },
	});
}

async function sessionFixture(api: ReturnType<typeof setup>, mode: 'app' | 'edit' = 'app') {
	await expectOk(await api.request('GET', '/me'));
	const { projects, notebooks, sessions } = api.deps.services;
	const project = await projects.createProject({ name: 'Private', description: '' }, ACTOR);
	const notebook = await notebooks.createNotebook(
		project.id,
		{
			title: 'App',
			description: '',
			code: 'SECRET_NOTEBOOK_CONTENT',
		},
		ACTOR,
	);
	const session = await sessions.createSession({
		project_id: project.id,
		notebook_id: notebook.id,
		user_id: ACTOR,
		mode,
		sandbox_id: SandboxId.parse('sb-0123456789abcdef'),
		runtime: { python_version: '3.13', marimo_version: '0.17.0' },
		compute_profile: 'small',
		sandbox_url: 'https://sandbox.example/?token=SECRET',
	});
	await sessions.markFailed(project.id, session.session_id, {
		code: 'START_FAILED',
		message: 'Startup failed',
	});
	return {
		project,
		notebook,
		context: {
			...CONTEXT,
			session: { project_id: project.id, notebook_id: notebook.id, id: session.session_id },
		},
	};
}

describe('support reports', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves diagnostics on the server and discards forged and sensitive fields', async () => {
		const api = setup();
		const { context } = await sessionFixture(api);
		const response = await api.request('POST', '/support/diagnostics', {
			...context,
			hub_version: 'fake',
			reporter: { id: 'fake', email: 'fake' },
			session: {
				...context.session,
				sandbox_id: 'forged',
				runtime: { python_version: 'forged' },
				env: { SECRET: 'secret' },
			},
		});
		expect(response.headers.get('cache-control')).toBe('no-store');
		const data = await expectOk(response);
		expect(data).toMatchObject({
			reporter: { id: ACTOR, email: `${ACTOR}@example.com` },
			hub_version: '1.2.3',
			page_url: 'https://hub.example/apps',
			session: {
				...context.session,
				sandbox_id: 'sb-0123456789abcdef',
				runtime: { python_version: '3.13' },
				compute_profile: 'small',
				error: { code: 'START_FAILED' },
			},
		});
		expect(JSON.stringify(data)).not.toMatch(/SECRET|forged|password|token|env/);
	});

	it('delivers a broadcast, records an audit event, and excludes project alerts', async () => {
		const api = setup();
		const append = vi.spyOn(api.deps.services.events, 'append');
		const result = await expectOk(await api.request('POST', '/support/requests', REPORT));
		expect(result).toMatchObject({ delivery: 'delivered', request_id: expect.any(String) });
		expect(api.notifier.deliveries).toHaveLength(1);
		expect(api.notifier.deliveries[0]).toMatchObject({
			kind: 'support.request',
			audience: 'broadcast',
			recipients: [],
			data: {
				message: REPORT.message,
				reporter: { id: ACTOR },
				page_url: 'https://hub.example/apps',
			},
		});
		expect(append).toHaveBeenCalledWith({
			event: 'support.request',
			actor: ACTOR,
			support_request_id: result.request_id,
			delivery: 'delivered',
		});
	});

	it('limits each reporter to five requests in ten minutes', async () => {
		const api = setup();
		for (let i = 0; i < 5; i++)
			await expectOk(await api.request('POST', '/support/requests', REPORT));
		const limited = await expectError(
			await api.request('POST', '/support/requests', REPORT),
			429,
			'RESOURCE_EXHAUSTED',
		);
		expect(limited.message).toBe('Too many support reports. Try again in a few minutes.');
		vi.spyOn(api.deps.authenticator, 'authenticate').mockResolvedValue({
			id: UserId.parse('other'),
			email: 'other@example.com',
			credential: { kind: 'development' },
		});
		await expectOk(await api.request('POST', '/support/requests', REPORT));
		expect(api.notifier.deliveries).toHaveLength(6);
	});

	it('admits the reporter again after the ten-minute window', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const api = setup();
		for (let i = 0; i < 5; i++)
			await expectOk(await api.request('POST', '/support/requests', REPORT));
		await expectError(await api.request('POST', '/support/requests', REPORT), 429);
		vi.advanceTimersByTime(10 * 60_000);
		await expectOk(await api.request('POST', '/support/requests', REPORT));
		expect(api.notifier.deliveries).toHaveLength(6);
	});

	it.each([
		{ caller: 'app user', error: { code: 'APP_FAILED' } },
		{ caller: 'default-role viewer', error: undefined },
	])('redacts session diagnostics for an $caller', async (scenario) => {
		const api = setup();
		const { project, context } = await sessionFixture(api);
		const userId = UserId.parse('reporter');
		const appUser = scenario.caller === 'app user';
		if (appUser) {
			await api.deps.services.projects.addMember(
				project.id,
				{ user_id: userId },
				'app-user',
				ACTOR,
			);
		}
		const caller = as(api, {
			userId,
			deps: appUser ? {} : { policy: { defaultRole: 'viewer' } },
		});
		const data = await expectOk(await caller.request('POST', '/support/diagnostics', context));
		expect(data.session).toMatchObject(context.session);
		expect(data.session.sandbox_id).toBeUndefined();
		if (scenario.error) expect(data.session.error).toMatchObject(scenario.error);
		else expect(data.session.error).toBeUndefined();
		expect(JSON.stringify(data)).not.toMatch(/sb-0123456789abcdef|Startup failed|START_FAILED/);
	});

	it('keeps the stored error and sandbox for a manager who can attach', async () => {
		const api = setup();
		const { project, context } = await sessionFixture(api);
		const manager = UserId.parse('manager');
		await api.deps.services.projects.addMember(project.id, { user_id: manager }, 'manager', ACTOR);
		const data = await expectOk(
			await as(api, { userId: manager }).request('POST', '/support/diagnostics', context),
		);
		expect(data.session).toMatchObject({
			sandbox_id: 'sb-0123456789abcdef',
			error: { code: 'START_FAILED', message: 'Startup failed' },
		});
	});

	it('withholds the sandbox and error from a project editor outside the app pool', async () => {
		const deps = { notifier: new MemoryNotifier(), policy: { defaultRole: 'editor' as const } };
		const owner = createTestApi({ compute: makeFakeCompute(), deps });
		await expectOk(await owner.request('GET', '/me'));
		const { projects, notebooks, sessions } = owner.deps.services;
		const project = await projects.createProject({ name: 'Pool', description: '' }, ACTOR);
		const notebook = await notebooks.createNotebook(
			project.id,
			{ title: 'App', description: '', code: 'x = 1' },
			ACTOR,
		);
		const started = await expectOk<any>(
			await owner.request('POST', `/projects/${project.id}/notebooks/${notebook.id}/sessions`, {
				mode: 'app',
				app_visit_id: 'tab',
			}),
		);
		await sessions.markFailed(project.id, started.session_id, {
			code: 'START_FAILED',
			message: 'Startup failed',
		});
		const context = {
			...CONTEXT,
			session: { project_id: project.id, notebook_id: notebook.id, id: started.session_id },
		};
		const member = await expectOk(await owner.request('POST', '/support/diagnostics', context));
		expect(member.session).toMatchObject({
			sandbox_id: expect.any(String),
			error: { code: 'START_FAILED' },
		});
		const outsider = createTestApi({ bucket: owner.bucket, userId: UserId.parse('bob'), deps });
		const data = await expectOk(await outsider.request('POST', '/support/diagnostics', context));
		expect(data.session).toMatchObject(context.session);
		expect(data.session.sandbox_id).toBeUndefined();
		expect(data.session.error).toBeUndefined();
	});

	it('allows app users to report their app but denies editor and hidden sessions', async () => {
		const api = setup();
		const { project, context } = await sessionFixture(api);
		const appUser = UserId.parse('app-viewer');
		await api.deps.services.projects.addMember(project.id, { user_id: appUser }, 'app-user', ACTOR);
		const app = as(api, { userId: appUser });
		await expectOk(
			await app.request('POST', '/support/requests', { ...context, message: 'Cannot start app' }),
		);
		const editor = await api.deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: context.session.notebook_id,
			user_id: ACTOR,
			mode: 'edit',
		});
		const stranger = as(api, { userId: UserId.parse('stranger') });
		for (const path of ['/support/diagnostics', '/support/requests']) {
			await expectError(
				await app.request('POST', path, {
					...context,
					session: { ...context.session, id: editor.session_id },
					message: REPORT.message,
				}),
				404,
			);
			await expectError(
				await stranger.request('POST', path, { ...context, message: REPORT.message }),
				404,
			);
		}
		expect(api.notifier.deliveries).toHaveLength(1);
		await expectError(
			await api.request('POST', '/support/diagnostics', {
				...context,
				session: { ...context.session, notebook_id: createNotebookId() },
			}),
			404,
		);
	});

	it.each(['credential action', 'credential project', 'security label', 'deleted notebook'])(
		'hides session diagnostics denied by %s before delivery',
		async (reason) => {
			const api = setup();
			const { project, notebook, context } = await sessionFixture(api);
			const security = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
			if (reason === 'security label') {
				await api.deps.services.notebooks.setSecurityLabels(
					project.id,
					notebook.id,
					{ classification: 'SECRET', compartments: [] },
					ACTOR,
				);
			} else if (reason === 'deleted notebook') {
				await api.deps.services.notebooks.deleteNotebook(project.id, notebook.id, ACTOR);
			}
			const scoped = as(api, {
				subject: {
					credential: {
						kind: 'personal-access-token',
						grant: {
							actions: reason === 'credential action' ? ['project.read'] : '*',
							projects: reason === 'credential project' ? [project.id] : '*',
						},
					},
				},
				deps: { resourceSecurity: security },
			});
			for (const path of ['/support/diagnostics', '/support/requests']) {
				await expectError(
					await scoped.request('POST', path, { ...context, message: REPORT.message }),
					reason === 'credential action' ? 403 : 404,
				);
			}
			expect(api.notifier.deliveries).toHaveLength(0);
		},
	);

	it('rejects anonymous requests and reports longer than 2000 characters', async () => {
		const anonymous = createTestApi({
			deps: { authenticator: { authenticate: async () => null } },
		});
		await expectError(await anonymous.request('POST', '/support/diagnostics', CONTEXT), 401);
		await expectError(await anonymous.request('POST', '/support/requests', REPORT), 401);
		const api = setup();
		await expectError(
			await api.request('POST', '/support/requests', { ...REPORT, message: 'x'.repeat(2001) }),
			422,
		);
		await expectError(
			await api.request('POST', '/support/requests', { ...REPORT, message: '  ' }),
			422,
		);
		expect(api.notifier.deliveries).toHaveLength(0);
	});

	it('keeps diagnostics available but rejects sending when reports are off', async () => {
		const api = createTestApi({
			deps: {
				notifier: new MemoryNotifier(),
				theme: { ...DEFAULT_THEME_CONFIG, support_url: '/support' },
			},
		});
		expect(await expectOk(await api.request('GET', '/capabilities'))).toMatchObject({
			support: { reports: false },
		});
		await expectOk(await api.request('POST', '/support/diagnostics', CONTEXT));
		await expectError(await api.request('POST', '/support/requests', REPORT), 404, 'NOT_FOUND');
	});

	it.each(['skipped', 'failed'] as const)(
		'does not claim delivery when notification is %s',
		async (outcome) => {
			const deliver = vi.fn(async () => {
				if (outcome === 'failed') throw new Error('secret transport failure');
				return 'skipped' as const;
			});
			const api = createTestApi({ deps: { supportReports: true, notifier: { deliver } } });
			const append = vi.spyOn(api.deps.services.events, 'append');
			const error = await expectError(await api.request('POST', '/support/requests', REPORT), 503);
			expect(JSON.stringify(error)).not.toContain('secret');
			expect(append).not.toHaveBeenCalledWith(
				expect.objectContaining({ event: 'support.request' }),
			);
		},
	);

	it('consumes the rate budget for failed deliveries without retrying the notifier', async () => {
		const api = setup();
		const deliver = vi.spyOn(api.notifier, 'deliver').mockRejectedValue(new Error('offline'));
		for (let i = 0; i < 5; i++)
			await expectError(await api.request('POST', '/support/requests', REPORT), 503);
		await expectError(await api.request('POST', '/support/requests', REPORT), 429);
		expect(deliver).toHaveBeenCalledTimes(5);
	});

	it('returns and audits partial delivery without retrying successful destinations', async () => {
		const deliver = vi.fn(async () => 'partial' as const);
		const api = createTestApi({ deps: { supportReports: true, notifier: { deliver } } });
		const append = vi.spyOn(api.deps.services.events, 'append');
		const result = await expectOk(await api.request('POST', '/support/requests', REPORT));
		expect(result.delivery).toBe('partial');
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(append).toHaveBeenCalledWith({
			event: 'support.request',
			actor: ACTOR,
			support_request_id: result.request_id,
			delivery: 'partial',
		});
	});

	it('rejects mismatched session reports before delivering or consuming the budget', async () => {
		const api = setup();
		const { context } = await sessionFixture(api);
		const append = vi.spyOn(api.deps.services.events, 'append');
		for (let i = 0; i < 6; i++) {
			await expectError(
				await api.request('POST', '/support/requests', {
					...context,
					session: { ...context.session, notebook_id: createNotebookId() },
					message: REPORT.message,
				}),
				404,
			);
		}
		expect(api.notifier.deliveries).toHaveLength(0);
		expect(append).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'support.request' }));
		await expectOk(await api.request('POST', '/support/requests', REPORT));
		expect(api.notifier.deliveries).toHaveLength(1);
	});

	it.each([
		{ ...CONTEXT, page_url: 'x'.repeat(2049) },
		{ ...CONTEXT, client: { ...CONTEXT.client, user_agent: 'x'.repeat(513) } },
		{ ...CONTEXT, client: { ...CONTEXT.client, error: 'x'.repeat(1001) } },
		{ ...CONTEXT, client: { ...CONTEXT.client, viewport: { width: -1, height: 768 } } },
		{ ...CONTEXT, client: { ...CONTEXT.client, viewport: { width: 1024, height: 1.5 } } },
	])('rejects invalid diagnostic context without sending: %j', async (context) => {
		const api = setup();
		await expectError(await api.request('POST', '/support/diagnostics', context), 422);
		await expectError(
			await api.request('POST', '/support/requests', { ...context, message: REPORT.message }),
			422,
		);
		expect(api.notifier.deliveries).toHaveLength(0);
	});
});
