import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	VIEWER_MODES,
	createProjectId,
	createJobId,
	createRunId,
	SECONDARY_SURFACE_IDS,
} from '@marimo-hub/core';
import type {
	NotebookId,
	ProjectId,
	SessionId,
	TokenGrant,
	SandboxProvider,
} from '@marimo-hub/core';
import {
	ACTOR,
	localResourceSecurity,
	makeFakeCompute,
	fakeComputeFrom,
	makeFakeSandbox,
	makeSubjectContext,
	uid,
} from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';

const STAKEHOLDER = uid('user_stakeholder');
let api: ReturnType<typeof createTestApi>;
let owner: ReturnType<typeof createTestApi>;
let services: ReturnType<typeof createServices>;
let pid: ProjectId;
let nid: NotebookId;
let base: string;

function stakeholderToken(grant: TokenGrant, compute: SandboxProvider = makeFakeCompute()) {
	return createTestApi({
		bucket: api.bucket,
		compute,
		deps: {
			policy: { viewerMode: 'applications' },
			authenticator: {
				authenticate: async () => ({
					id: STAKEHOLDER,
					email: 'stakeholder@example.com',
					credential: { kind: 'personal-access-token', grant },
				}),
			},
		},
	});
}

beforeEach(async () => {
	const bucket = await createInitializedBucket();
	services = createServices(bucket);
	const project = await services.projects.createProject(
		{ name: 'Analytics', description: 'Private project detail' },
		ACTOR,
	);
	pid = project.id;
	const notebook = await services.notebooks.createNotebook(
		pid,
		{ title: 'Sales', description: 'Private notebook detail', code: 'SOURCE_ONLY_SENTINEL = 42' },
		ACTOR,
	);
	nid = notebook.id;
	base = `/projects/${pid}/notebooks/${nid}`;
	await services.projects.addMember(pid, { user_id: STAKEHOLDER }, 'app-user', ACTOR);
	api = createTestApi({ bucket, userId: STAKEHOLDER, compute: makeFakeCompute() });
	owner = createTestApi({ bucket, compute: makeFakeCompute() });
});

describe('app-user access', () => {
	it('discovers apps without project or notebook detail', async () => {
		const items = await expectPage(await api.request('GET', '/apps'));
		expect(items).toEqual([
			{
				project_id: pid,
				project_name: 'Analytics',
				notebook_id: nid,
				title: 'Sales',
				url: `${base}/app`,
				your_role: 'app-user',
				can: { run: true },
			},
		]);
		expect(await expectOk(await api.request('GET', `${base}/app`))).toEqual(items[0]);
		expect(await expectPage(await api.request('GET', '/projects'))).toEqual([]);
		await expectError(await api.request('GET', `/projects/${pid}`), 404);
		await expectError(await api.request('GET', base), 404);
	});

	it('accepts an email invitation as app-only access', async () => {
		const invitee = uid('invited_stakeholder');
		await expectOk(
			await owner.request('POST', `/projects/${pid}/members`, {
				email: `${invitee}@example.com`,
				role: 'app-user',
			}),
			201,
		);
		const invited = createTestApi({ bucket: api.bucket, userId: invitee });
		expect(await expectOk(await invited.request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
		expect(await expectPage(await invited.request('GET', '/apps'))).toHaveLength(1);
		await expectError(await invited.request('GET', `${base}/content`), 404);
	});

	it.each(['viewer', 'editor'] as const)(
		'keeps legacy email-invited %s access when the deployment default is app-user',
		async (role) => {
			const invitee = uid('legacy_invitee');
			await services.projects.addMember(pid, { email: `${invitee}@example.com` }, role, ACTOR);
			await services.catalog.updateProjectEntry('test.strip', ACTOR, pid, () => ({
				member_emails: undefined,
			}));
			const invited = createTestApi({
				bucket: api.bucket,
				userId: invitee,
				deps: { policy: { defaultRole: 'app-user' } },
			});

			expect(await expectOk(await invited.request('GET', '/me'))).toMatchObject({
				app_only: false,
				can_create_projects: true,
			});
			const projects = await expectPage<{ id: string }>(await invited.request('GET', '/projects'));
			expect(projects.map((project) => project.id)).toEqual([pid]);
			expect(await expectOk(await invited.request('GET', `${base}/app`))).toMatchObject({
				your_role: role,
			});
			await expectOk(
				await invited.request('POST', '/projects', { name: 'Allowed', description: '' }),
				201,
			);
		},
	);

	it('resolves inherited app links', async () => {
		await expectOk(await owner.request('POST', `${base}/deep-links`, { slug: 'sales' }));
		expect(await expectOk(await api.request('GET', '/deep-links/sales'))).toMatchObject({
			target: { notebook_id: nid },
		});
		await expectError(await api.request('POST', `${base}/deep-links`, { slug: 'other' }), 403);
	});

	it.each(VIEWER_MODES)('uses only app sessions under %s viewer mode', async (viewerMode) => {
		const client = createTestApi({
			bucket: api.bucket,
			userId: STAKEHOLDER,
			compute: makeFakeCompute(),
			deps: { policy: { viewerMode } },
		});
		const session = await expectOk<{
			session_id: SessionId;
			sandbox_url: string;
			can: { attach: boolean; stop: boolean };
		}>(await client.request('POST', `${base}/sessions`, { mode: 'app' }));
		expect(session.can).toMatchObject({ attach: true, stop: false });
		expect(session.sandbox_url).toBeTruthy();
		for (const suffix of ['', '/heartbeat']) {
			const response = await expectOk(
				await client.request(
					suffix ? 'POST' : 'GET',
					`${base}/sessions/${session.session_id}${suffix}`,
				),
			);
			expect(response).toMatchObject({ session_id: session.session_id });
			for (const field of ['source_version_id', 'integrations', 'compute_profile', 'surfaces'])
				expect(response).not.toHaveProperty(field);
		}
		await expectError(await client.request('POST', `${base}/sessions`, { mode: 'edit' }), 403);
		await expectError(
			await client.request('POST', `${base}/sessions`, { mode: 'app', compute_profile: 'default' }),
			403,
		);
		await expectError(
			await client.request('DELETE', `${base}/sessions/${session.session_id}`),
			404,
		);
		await expectError(await client.request('GET', `/projects/${pid}/sessions`), 404);
		for (const surface of SECONDARY_SURFACE_IDS) {
			await expectError(
				await client.request('POST', `${base}/sessions`, { mode: 'app', surfaces: [surface] }),
				403,
			);
			for (const method of ['GET', 'POST', 'DELETE'] as const) {
				await expectError(
					await client.request(
						method,
						`${base}/sessions/${session.session_id}/surfaces/${surface}`,
					),
					404,
				);
			}
		}
	});

	it.each([
		'/content',
		'/workspace/access',
		'/workspace/entries',
		'/workspace/files?path=notebook.py',
		'/workspace.zip',
		'/versions',
		'/html',
		'/jobs',
		'/deep-links',
	])('denies %s', async (suffix) => {
		await expectError(await api.request('GET', `${base}${suffix}`), 404);
	});

	it('blocks project creation only for app-only users', async () => {
		expect(await expectOk(await api.request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
		await expectError(
			await api.request('POST', '/projects', { name: 'Forbidden', description: '' }),
			403,
		);
		const other = await services.projects.createProject({ name: 'Work', description: '' }, ACTOR);
		await services.projects.addMember(other.id, { user_id: STAKEHOLDER }, 'viewer', ACTOR);
		expect(await expectOk(await api.request('GET', '/me'))).toMatchObject({
			app_only: false,
			can_create_projects: true,
		});
		const items = await expectPage<{ id: string }>(await api.request('GET', '/projects'));
		expect(items.map((item) => item.id)).toEqual([other.id]);
	});

	it('does not let a broad default bypass an explicit app-user membership', async () => {
		const client = createTestApi({
			bucket: api.bucket,
			userId: STAKEHOLDER,
			deps: { policy: { defaultRole: 'editor' } },
		});
		expect(await expectPage(await client.request('GET', '/projects'))).toEqual([]);
		await expectError(await client.request('GET', `${base}/content`), 404);
		expect(await expectOk(await client.request('GET', `${base}/app`))).toMatchObject({
			your_role: 'app-user',
		});
	});

	it('filters searches, project selections, and deleted resources', async () => {
		expect(await expectPage(await api.request('GET', '/apps?q=no-match'))).toEqual([]);
		expect(await expectPage(await api.request('GET', '/apps?q=ANALYTICS'))).toHaveLength(1);
		await services.notebooks.deleteNotebook(pid, nid, ACTOR);
		expect(await expectPage(await api.request('GET', '/apps'))).toEqual([]);
		await expectError(await api.request('GET', `${base}/app`), 404);
	});
});

describe('app-user boundaries', () => {
	it('does not grant ownership to the first app-user on an empty deployment', async () => {
		const fresh = createTestApi({
			userId: STAKEHOLDER,
			deps: { policy: { defaultRole: 'app-user' } },
		});
		expect(await expectOk(await fresh.request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
		expect(await expectPage(await fresh.request('GET', '/apps'))).toEqual([]);
		expect((await fresh.deps.services.catalog.getCurrentSnapshot()).projects).toEqual([]);
	});

	it('applies project and notebook labels to discovery and direct access', async () => {
		const labels = { classification: 'SECRET', compartments: ['finance'] };
		await services.notebooks.setSecurityLabels(pid, nid, labels, ACTOR);
		const restricted = createTestApi({
			bucket: api.bucket,
			userId: STAKEHOLDER,
			deps: {
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ compartments: [] }),
				),
			},
		});
		expect(await expectPage(await restricted.request('GET', '/apps'))).toEqual([]);
		await expectError(await restricted.request('GET', `${base}/app`), 404);
		await expectError(await restricted.request('POST', `${base}/sessions`, { mode: 'app' }), 404);
		await services.notebooks.setSecurityLabels(pid, nid, undefined, ACTOR);
		await services.projects.setSecurityLabels(pid, labels, ACTOR);
		expect(await expectPage(await restricted.request('GET', '/apps'))).toEqual([]);
		await expectError(await restricted.request('GET', `${base}/app`), 404);
	});

	it('computes run permission with action-specific notebook constraints', async () => {
		const labels = { classification: 'SECRET', compartments: ['finance'] };
		await services.notebooks.setSecurityLabels(pid, nid, labels, ACTOR);
		const security = localResourceSecurity(['SECRET'], makeSubjectContext());
		const evaluate = vi
			.spyOn(security.constraints, 'evaluate')
			.mockImplementation(async (_context, action) =>
				action === 'session.start'
					? { satisfied: false, reason: 'constraint' }
					: { satisfied: true },
			);
		vi.spyOn(security.constraints, 'evaluateMany').mockImplementation(
			async (_context, _action, resources) => resources.map(() => ({ satisfied: true })),
		);
		const client = createTestApi({
			bucket: api.bucket,
			userId: STAKEHOLDER,
			deps: { resourceSecurity: security },
		});
		expect(await expectPage(await client.request('GET', '/apps'))).toEqual([
			expect.objectContaining({ notebook_id: nid, can: { run: false } }),
		]);
		expect(await expectOk(await client.request('GET', `${base}/app`))).toMatchObject({
			can: { run: false },
		});
		expect(evaluate).toHaveBeenCalledWith(
			expect.anything(),
			'session.start',
			{ labels },
			expect.any(AbortSignal),
		);
		await expectError(await client.request('POST', `${base}/sessions`, { mode: 'app' }), 404);
		expect(await services.sessions.listSessions(nid)).toEqual([]);
	});

	it.each(['deleted', 'revoked'] as const)(
		'skips a project %s after the gallery catalog read',
		async (change) => {
			const other = await services.projects.createProject(
				{ name: 'Still visible', description: '' },
				ACTOR,
			);
			await services.projects.addMember(other.id, { user_id: STAKEHOLDER }, 'app-user', ACTOR);
			const notebook = await services.notebooks.createNotebook(
				other.id,
				{ title: 'Available', description: '', code: 'pass' },
				ACTOR,
			);
			const listProjects = api.deps.services.projects.listProjects.bind(api.deps.services.projects);
			vi.spyOn(api.deps.services.projects, 'listProjects').mockImplementationOnce(
				async (filter) => {
					const projects = await listProjects(filter);
					if (change === 'deleted') await services.projects.deleteProject(pid, ACTOR);
					else await services.projects.removeMember(pid, STAKEHOLDER, ACTOR);
					return projects;
				},
			);
			const page = await expectOk<{ items: { notebook_id: string }[]; next_cursor: null }>(
				await api.request('GET', '/apps'),
			);
			expect(page.items).toEqual([expect.objectContaining({ notebook_id: notebook.id })]);
			expect(page.next_cursor).toBeNull();
		},
	);

	it('does not suppress unexpected project load errors in the gallery', async () => {
		vi.spyOn(api.deps.services.notebooks, 'listNotebooks').mockRejectedValueOnce(
			new Error('Storage unavailable'),
		);
		await expectError(await api.request('GET', '/apps'), 500);
	});

	it('enforces token action and project scopes without widening stored grants', async () => {
		const token = (actions: ['app.read'] | ['project.read'], projects: ProjectId[]) =>
			stakeholderToken({ actions, projects });
		await expectError(await token(['project.read'], [pid]).request('GET', '/apps'), 403);
		const allowed = token(['app.read'], [pid]);
		expect(await expectOk(await allowed.request('GET', `${base}/app`))).toMatchObject({
			can: { run: false },
		});
		await expectError(await allowed.request('GET', `${base}/content`), 404);
		const outside = token(['app.read'], [createProjectId()]);
		expect(await expectPage(await outside.request('GET', '/apps'))).toEqual([]);
		await expectError(await outside.request('GET', `${base}/app`), 404);
	});

	it('requires an explicit creation entitlement even with an app-user default', async () => {
		const client = (creator: boolean) =>
			createTestApi({
				bucket: api.bucket,
				deps: {
					policy: { defaultRole: 'app-user' },
					authenticator: {
						authenticate: async () => ({
							id: STAKEHOLDER,
							email: 'stakeholder@example.com',
							credential: { kind: 'sso' },
							entitlements: creator ? ['project-creator'] : [],
						}),
					},
				},
			});
		expect(await expectOk(await client(false).request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
		expect(await expectOk(await client(true).request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: true,
		});
		await expectOk(
			await client(true).request('POST', '/projects', { name: 'My project', description: '' }),
			201,
		);
		expect(await expectOk(await client(false).request('GET', '/me'))).toMatchObject({
			app_only: false,
		});
	});

	it('filters before pagination and does not disclose hidden project names', async () => {
		const hidden = await services.projects.createProject(
			{ name: 'Hidden project', description: '' },
			ACTOR,
		);
		await services.notebooks.createNotebook(
			hidden.id,
			{ title: 'Hidden source', description: '', code: 'secret' },
			ACTOR,
		);
		await services.notebooks.createNotebook(
			pid,
			{ title: 'Second app', description: '', code: 'pass' },
			ACTOR,
		);
		const first = await expectOk<{ items: { title: string }[]; next_cursor: string }>(
			await api.request('GET', '/apps?limit=1'),
		);
		const second = await expectOk<{ items: { title: string }[]; next_cursor: null }>(
			await api.request('GET', `/apps?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`),
		);
		expect([...first.items, ...second.items].map((item) => item.title).sort()).toEqual([
			'Sales',
			'Second app',
		]);
		expect(second.next_cursor).toBeNull();
		await expectError(await api.request('GET', `/apps?project_id=${hidden.id}`), 404);
	});
});

it.each(['app-user', 'viewer', 'editor'] as const)(
	'returns generic app startup failures for app-scoped %s access',
	async (role) => {
		await services.projects.updateMemberRole(pid, STAKEHOLDER, role, ACTOR);
		const { instance } = makeFakeSandbox();
		const client = stakeholderToken(
			{ projects: [pid], actions: ['app.read', 'session.start', 'session.attach'] },
			fakeComputeFrom({
				...instance,
				exec: async (command) =>
					command.includes('uv sync')
						? {
								success: false,
								stdout: '',
								stderr: 'SOURCE_ONLY_SENTINEL',
								error: { code: 'COMMAND_FAILED' },
							}
						: instance.exec(command),
			}),
		);
		const failure = await expectError(
			await client.request('POST', `${base}/sessions`, { mode: 'app' }),
			503,
		);
		expect(failure.message).toBe('The app could not start. Contact its owner.');
		const [session] = await services.sessions.listSessions(nid);
		const response = await expectOk(
			await client.request('GET', `${base}/sessions/${session.session_id}`),
		);
		expect(response.error).toEqual({
			code: 'APP_FAILED',
			message: 'The app could not start. Contact its owner.',
		});
		expect(JSON.stringify(response)).not.toContain('SOURCE_ONLY_SENTINEL');
	},
);

it('blocks existing version code and version HTML through direct URLs', async () => {
	const { source } = await services.notebooks.getNotebook(pid, nid);
	const versionPath = `${base}/versions/${source.current_version_id}`;
	await expectOk(await owner.request('GET', versionPath));
	await expectError(await api.request('GET', versionPath), 404);
	await expectError(await api.request('GET', `${versionPath}/html`), 404);
});

it('denies integration details and job history, outputs, and logs', async () => {
	await expectError(await api.request('GET', `/projects/${pid}/integrations`), 404);
	const run = `${base}/jobs/${createJobId()}/runs/${createRunId()}`;
	for (const path of [run, `${run}/html`]) {
		await expectError(await api.request('GET', path), 404);
	}
	await expectError(await api.request('GET', `${run}/logs`), 403);
});

it('preserves existing project-read token access to labeled viewer app sessions', async () => {
	await services.projects.updateMemberRole(pid, STAKEHOLDER, 'viewer', ACTOR);
	await services.notebooks.setSecurityLabels(
		pid,
		nid,
		{ classification: 'PUBLIC', compartments: [] },
		ACTOR,
	);
	const client = createTestApi({
		bucket: api.bucket,
		compute: makeFakeCompute(),
		deps: {
			policy: { viewerMode: 'applications' },
			resourceSecurity: localResourceSecurity(
				['PUBLIC'],
				makeSubjectContext({ classification: 'PUBLIC', compartments: [] }),
			),
			authenticator: {
				authenticate: async () => ({
					id: STAKEHOLDER,
					email: 'viewer@example.com',
					credential: {
						kind: 'personal-access-token',
						grant: {
							actions: ['project.read', 'session.start', 'session.attach'],
							projects: [pid],
						},
					},
				}),
			},
		},
	});
	const session = await expectOk<{ session_id: string }>(
		await client.request('POST', `${base}/sessions`, { mode: 'app' }),
	);
	await expectOk(await client.request('GET', `${base}/sessions/${session.session_id}`));
	await expectOk(await client.request('POST', `${base}/sessions/${session.session_id}/heartbeat`));
});

describe('app access after authorization changes', () => {
	it.each(['membership', 'project', 'notebook', 'labels'] as const)(
		'revokes discovery, links, and live session reads after changing %s',
		async (change) => {
			await expectOk(await owner.request('POST', `${base}/deep-links`, { slug: 'revoked-app' }));
			const session = await expectOk<{ session_id: SessionId }>(
				await api.request('POST', `${base}/sessions`, { mode: 'app' }),
			);
			if (change === 'membership') await services.projects.removeMember(pid, STAKEHOLDER, ACTOR);
			if (change === 'project') await services.projects.deleteProject(pid, ACTOR);
			if (change === 'notebook') await services.notebooks.deleteNotebook(pid, nid, ACTOR);
			if (change === 'labels')
				await services.notebooks.setSecurityLabels(
					pid,
					nid,
					{
						classification: 'SECRET',
						compartments: ['restricted'],
					},
					ACTOR,
				);
			expect(await expectPage(await api.request('GET', '/apps'))).toEqual([]);
			for (const path of [
				`${base}/app`,
				'/deep-links/revoked-app',
				`${base}/sessions/${session.session_id}`,
			]) {
				await expectError(await api.request('GET', path), 404);
			}
			await expectError(
				await api.request('POST', `${base}/sessions/${session.session_id}/heartbeat`),
				404,
			);
		},
	);

	it.each(['editor', 'viewer'] as const)(
		'blocks all former %s session privileges after downgrade',
		async (role) => {
			await services.projects.updateMemberRole(pid, STAKEHOLDER, role, ACTOR);
			const client = createTestApi({
				bucket: api.bucket,
				userId: STAKEHOLDER,
				compute: makeFakeCompute(),
				deps: {
					policy: { viewerMode: 'ephemeral-sandbox' },
				},
			});
			const editor = await expectOk<{ session_id: SessionId }>(
				await client.request('POST', `${base}/sessions`, { mode: 'edit' }),
			);
			await services.projects.updateMemberRole(pid, STAKEHOLDER, 'app-user', ACTOR);
			const sessionPath = `${base}/sessions/${editor.session_id}`;
			for (const method of ['GET', 'DELETE'] as const)
				await expectError(await client.request(method, sessionPath), 404);
			await expectError(await client.request('POST', `${sessionPath}/heartbeat`), 404);
			for (const surface of SECONDARY_SURFACE_IDS)
				await expectError(await client.request('POST', `${sessionPath}/surfaces/${surface}`), 404);
			const app = await expectOk<{ session_id: SessionId; mode: string }>(
				await client.request('POST', `${base}/sessions`, { mode: 'app' }),
			);
			expect(app.mode).toBe('app');
			expect(app.session_id).not.toBe(editor.session_id);
			expect(app).not.toHaveProperty('editor_session');
		},
	);

	it('does not treat an app session ID as authority for another notebook or project', async () => {
		const started = await expectOk<{ session_id: SessionId }>(
			await api.request('POST', `${base}/sessions`, { mode: 'app' }),
		);
		const otherProject = await services.projects.createProject(
			{ name: 'Other', description: '' },
			ACTOR,
		);
		await services.projects.addMember(otherProject.id, { user_id: STAKEHOLDER }, 'app-user', ACTOR);
		const otherNotebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'Other', description: '', code: 'pass' },
			ACTOR,
		);
		for (const path of [
			`/projects/${otherProject.id}/notebooks/${nid}/sessions/${started.session_id}`,
			`/projects/${pid}/notebooks/${otherNotebook.id}/sessions/${started.session_id}`,
		]) {
			await expectError(await api.request('GET', path), 404);
			await expectError(await api.request('POST', `${path}/heartbeat`), 404);
		}
	});

	it('reclassifies a mixed-role account when its only higher membership disappears', async () => {
		const other = await services.projects.createProject({ name: 'Work', description: '' }, ACTOR);
		await services.projects.addMember(other.id, { user_id: STAKEHOLDER }, 'viewer', ACTOR);
		expect(await expectOk(await api.request('GET', '/me'))).toMatchObject({
			app_only: false,
			can_create_projects: true,
		});
		await services.projects.removeMember(other.id, STAKEHOLDER, ACTOR);
		expect(await expectOk(await api.request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
		await expectError(
			await api.request('POST', '/projects', { name: 'No longer allowed', description: '' }),
			403,
		);
	});

	it('does not count deleted higher-role projects toward project-creation standing', async () => {
		const other = await services.projects.createProject({ name: 'Work', description: '' }, ACTOR);
		await services.projects.addMember(other.id, { user_id: STAKEHOLDER }, 'manager', ACTOR);
		await services.projects.deleteProject(other.id, ACTOR);
		expect(await expectOk(await api.request('GET', '/me'))).toMatchObject({
			app_only: true,
			can_create_projects: false,
		});
	});

	it('keeps a static viewer restricted even when the deployment default grants app access', async () => {
		await services.projects.updateMemberRole(pid, STAKEHOLDER, 'viewer', ACTOR);
		const viewer = createTestApi({
			bucket: api.bucket,
			userId: STAKEHOLDER,
			deps: { policy: { defaultRole: 'app-user', viewerMode: 'static' } },
		});
		expect(await expectOk(await viewer.request('GET', `${base}/app`))).toMatchObject({
			your_role: 'viewer',
			can: { run: false },
		});
		await expectError(await viewer.request('POST', `${base}/sessions`, { mode: 'app' }), 403);
		await expectOk(await viewer.request('GET', `${base}/content`));
	});
});

describe('app session credential boundaries', () => {
	it.each(['app-user', 'viewer', 'editor', 'manager'] as const)(
		'withholds kernel URLs and metadata from app-scoped %s tokens without attach',
		async (role) => {
			await services.projects.updateMemberRole(pid, STAKEHOLDER, role, ACTOR);
			const client = stakeholderToken({ projects: [pid], actions: ['app.read', 'session.start'] });
			const session = await expectOk<{ session_id: SessionId }>(
				await client.request('POST', `${base}/sessions`, { mode: 'app' }),
			);
			expect(session).toMatchObject({ can: { attach: false, stop: false } });
			for (const field of [
				'user_id',
				'sandbox_url',
				'source_version_id',
				'compute_profile',
				'compute_resources',
				'surfaces',
				'integrations',
			]) {
				expect(session).not.toHaveProperty(field);
			}
			const read = await client.request('GET', `${base}/sessions/${session.session_id}`);
			if (role === 'app-user') {
				await expectError(read, 403);
			} else {
				const response = await expectOk(read);
				expect(response).toMatchObject({ can: { attach: false } });
				expect(response).not.toHaveProperty('sandbox_url');
				expect(response).not.toHaveProperty('source_version_id');
				expect(response).not.toHaveProperty('user_id');
			}
			await expectError(
				await client.request('POST', `${base}/sessions/${session.session_id}/heartbeat`),
				403,
			);
		},
	);

	it('permits attach-only tokens to keep an existing app alive but not to provision one', async () => {
		const session = await expectOk<{ session_id: SessionId }>(
			await api.request('POST', `${base}/sessions`, { mode: 'app' }),
		);
		const client = stakeholderToken({ projects: [pid], actions: ['app.read', 'session.attach'] });
		await expectOk(await client.request('GET', `${base}/sessions/${session.session_id}`));
		await expectOk(
			await client.request('POST', `${base}/sessions/${session.session_id}/heartbeat`),
		);
		await expectError(await client.request('POST', `${base}/sessions`, { mode: 'app' }), 403);
	});

	it('rejects out-of-scope session IDs on both reads and mutations', async () => {
		const session = await expectOk<{ session_id: SessionId }>(
			await api.request('POST', `${base}/sessions`, { mode: 'app' }),
		);
		const client = stakeholderToken({
			projects: [createProjectId()],
			actions: ['app.read', 'session.start', 'session.attach'],
		});
		await expectError(await client.request('GET', `${base}/sessions/${session.session_id}`), 404);
		await expectError(
			await client.request('POST', `${base}/sessions/${session.session_id}/heartbeat`),
			404,
		);
		await expectError(await client.request('POST', `${base}/sessions`, { mode: 'app' }), 404);
	});

	it.each([{}, { mode: 'app', edit_intent: 'temporary' }] as const)(
		'rejects editor defaults and customization before provisioning: %j',
		async (body) => {
			await expectError(await api.request('POST', `${base}/sessions`, body), 403);
			expect(await services.sessions.listSessions(nid)).toEqual([]);
		},
	);

	it.each(['app-user', 'viewer', 'editor', 'manager'] as const)(
		'redacts populated operational fields for app-scoped %s access',
		async (role) => {
			await services.projects.updateMemberRole(pid, STAKEHOLDER, role, ACTOR);
			const client =
				role === 'app-user'
					? api
					: stakeholderToken({
							projects: [pid],
							actions: ['app.read', 'session.start', 'session.attach'],
						});
			const { source } = await services.notebooks.getNotebook(pid, nid);
			const session = await services.sessions.createSession({
				project_id: pid,
				notebook_id: nid,
				user_id: ACTOR,
				mode: 'app',
				source_version_id: source.current_version_id!,
				compute_profile: 'private-profile',
				compute_resources: { cpu: 4, memory_bytes: 1024 },
				compute_from_snapshot: true,
			});
			await services.sessions.setRunning(
				pid,
				session.session_id,
				'https://app.example.com/',
				false,
				'https://internal.example.com/',
			);
			await services.sessions.claimApp(pid, nid, session.session_id);
			const author = await expectOk(
				await owner.request('GET', `${base}/sessions/${session.session_id}`),
			);
			expect(author).toHaveProperty('user_id', ACTOR);
			expect(author).toHaveProperty('source_version_id');
			expect(author).toHaveProperty('compute_profile', 'private-profile');
			expect(author).toHaveProperty('surfaces');
			for (const [method, path, body] of [
				['POST', `${base}/sessions`, { mode: 'app' }],
				['GET', `${base}/sessions/${session.session_id}`, undefined],
				['POST', `${base}/sessions/${session.session_id}/heartbeat`, undefined],
			] as const) {
				const response = await expectOk(await client.request(method, path, body));
				expect(response).toMatchObject({
					session_id: session.session_id,
					sandbox_url: 'https://app.example.com/',
				});
				for (const field of [
					'user_id',
					'source_version_id',
					'compute_profile',
					'compute_resources',
					'compute_from_snapshot',
					'surfaces',
					'sandbox_origin_url',
				]) {
					expect(response).not.toHaveProperty(field);
				}
			}
		},
	);
});

it.each([
	['project.read', 'session.start', 'session.attach'],
	['app.read', 'project.read', 'session.start', 'session.attach'],
	'*',
] as const)(
	'preserves app operational metadata for a viewer credential with project reads: %j',
	async (actions) => {
		await services.projects.updateMemberRole(pid, STAKEHOLDER, 'viewer', ACTOR);
		const client = stakeholderToken({
			projects: [pid],
			actions: actions === '*' ? '*' : [...actions],
		});
		const session = await expectOk<{ session_id: SessionId }>(
			await client.request('POST', `${base}/sessions`, { mode: 'app' }),
		);
		for (const response of [
			session,
			await expectOk(await client.request('GET', `${base}/sessions/${session.session_id}`)),
			await expectOk(
				await client.request('POST', `${base}/sessions/${session.session_id}/heartbeat`),
			),
		]) {
			expect(response).toHaveProperty('user_id', STAKEHOLDER);
			expect(response).toHaveProperty('source_version_id');
			expect(response).toHaveProperty('surfaces');
		}
	},
);

it.each(['notebook', 'project'] as const)(
	'returns not found when an app-user starts an app whose %s is deleted during provisioning',
	async (resource) => {
		const fake = makeFakeSandbox();
		const client = createTestApi({
			bucket: api.bucket,
			userId: STAKEHOLDER,
			compute: fakeComputeFrom({
				...fake.instance,
				startProcess: async (...args) => {
					if (resource === 'notebook') {
						await services.notebooks.deleteNotebook(pid, nid, ACTOR);
					} else {
						await services.projects.deleteProject(pid, ACTOR);
					}
					return fake.instance.startProcess(...args);
				},
			}),
		});
		await expectError(
			await client.request('POST', `${base}/sessions`, { mode: 'app' }),
			404,
			'NOT_FOUND',
		);
		expect(fake.calls.destroy).toBeGreaterThan(0);
		expect(await services.sessions.countActiveAppsForProject(pid)).toBe(0);
		await expectError(await client.request('GET', `${base}/app`), 404, 'NOT_FOUND');
	},
);
