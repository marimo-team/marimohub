import { describe, expect, it, vi } from 'vitest';
import { createNotebookId, SandboxId, UserId } from '@marimo-hub/core';
import { ACTOR, MemoryNotifier } from '@marimo-hub/core/testing';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { createTestApi, expectError, expectOk } from '../testing';

const CONTEXT = {
	page_url: 'https://user:password@hub.example/apps?token=secret#private',
	client: { user_agent: 'test browser', viewport: { width: 1024, height: 768 } },
};
const REPORT = { ...CONTEXT, message: 'The app did not start' };

function setup() {
	const notifier = new MemoryNotifier();
	const api = createTestApi({
		deps: { notifier, supportMode: 'notifier', version: { version: '1.2.3' } },
	});
	return { ...api, notifier };
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
		await expectError(
			await api.request('POST', '/support/requests', REPORT),
			429,
			'RESOURCE_EXHAUSTED',
		);
		vi.spyOn(api.deps.authenticator, 'authenticate').mockResolvedValue({
			id: UserId.parse('other'),
			email: 'other@example.com',
			credential: { kind: 'development' },
		});
		await expectOk(await api.request('POST', '/support/requests', REPORT));
		expect(api.notifier.deliveries).toHaveLength(6);
	});

	it('allows app users to report their app but denies editor and hidden sessions', async () => {
		const api = setup();
		const { project, context } = await sessionFixture(api);
		const appUser = UserId.parse('app-viewer');
		await api.deps.services.projects.addMember(project.id, { user_id: appUser }, 'app-user', ACTOR);
		const app = createTestApi({
			bucket: api.bucket,
			userId: appUser,
			deps: { notifier: api.notifier, supportMode: 'notifier' },
		});
		await expectOk(
			await app.request('POST', '/support/requests', { ...context, message: 'Cannot start app' }),
		);
		const editor = await api.deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: context.session.notebook_id,
			user_id: ACTOR,
			mode: 'edit',
		});
		const stranger = createTestApi({
			bucket: api.bucket,
			userId: UserId.parse('stranger'),
			deps: { notifier: api.notifier, supportMode: 'notifier' },
		});
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

	it.each(['off', 'url'] as const)(
		'keeps diagnostics available but rejects sending in %s mode',
		async (mode) => {
			const api = createTestApi({
				deps: { supportMode: mode, theme: { ...DEFAULT_THEME_CONFIG, support_url: '/support' } },
			});
			expect(await expectOk(await api.request('GET', '/capabilities'))).toMatchObject({
				support: { mode },
			});
			await expectOk(await api.request('POST', '/support/diagnostics', CONTEXT));
			await expectError(await api.request('POST', '/support/requests', REPORT), 403);
		},
	);

	it.each(['skipped', 'failed'] as const)(
		'does not claim delivery when notification is %s',
		async (outcome) => {
			const deliver = vi.fn(async () => {
				if (outcome === 'failed') throw new Error('secret transport failure');
				return 'skipped' as const;
			});
			const api = createTestApi({ deps: { supportMode: 'notifier', notifier: { deliver } } });
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
		const api = createTestApi({ deps: { supportMode: 'notifier', notifier: { deliver } } });
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
