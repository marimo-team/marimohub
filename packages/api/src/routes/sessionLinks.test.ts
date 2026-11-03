import { describe, expect, it } from 'vitest';
import { createNotebookId, createSandboxId, SessionId } from '@marimo-hub/core';
import { ACTOR, makeFakeCompute, uid } from '@marimo-hub/core/testing';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';
import type { SessionCreateResult } from './sessions';

const theme = {
	...DEFAULT_THEME_CONFIG,
	session_links: [
		{
			id: 'lookout',
			label: 'Lookout',
			href_template:
				'https://lookout.example/{project_id}/{notebook_id}?jobSet={sandbox_id}&session={session_id}',
		},
	],
};

async function setup() {
	const bucket = await createInitializedBucket();
	const api = createTestApi({ bucket, compute: makeFakeCompute(), deps: { theme } });
	const { projects, notebooks } = api.deps.services;
	const project = await projects.createProject({ name: 'Links', description: '' }, ACTOR);
	const notebook = await notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo as mo' },
		ACTOR,
	);
	return {
		...api,
		bucket,
		pid: project.id,
		nid: notebook.id,
		path: `/projects/${project.id}/notebooks/${notebook.id}/sessions`,
		seedSession: (
			overrides: Partial<Parameters<typeof api.deps.services.sessions.createSession>[0]> = {},
		) =>
			api.deps.services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: ACTOR,
				sandbox_id: createSandboxId(),
				...overrides,
			}),
	};
}

describe('configured session links', () => {
	it('omits sandbox-dependent links before a sandbox ID exists without losing other links', async () => {
		const { bucket, path, seedSession } = await setup();
		const session = await seedSession({ sandbox_id: undefined });
		const { request } = createTestApi({
			bucket,
			deps: {
				theme: {
					...theme,
					session_links: [
						...theme.session_links,
						{ id: 'logs', label: 'Logs', href_template: 'https://logs.example/{session_id}' },
					],
				},
			},
		});
		const data = await expectOk(await request('GET', `${path}/${session.session_id}`));
		expect(data.links).toEqual([
			{ id: 'logs', label: 'Logs', href: `https://logs.example/${session.session_id}` },
		]);
	});

	it('rechecks access after a member is downgraded and removed', async () => {
		const { deps, bucket, pid, path, seedSession } = await setup();
		const user = uid('member');
		await deps.services.projects.addMember(pid, { user_id: user }, 'editor', ACTOR);
		const session = await seedSession();
		const { request } = createTestApi({ bucket, userId: user, deps: { theme } });
		const sessionPath = `${path}/${session.session_id}`;
		expect((await expectOk(await request('GET', sessionPath))).links).toHaveLength(1);

		await deps.services.projects.updateMemberRole(pid, user, 'viewer', ACTOR);
		const downgraded = await expectOk(await request('GET', sessionPath));
		expect(downgraded.can.attach).toBe(false);
		expect(downgraded).not.toHaveProperty('links');
		await expectError(await request('POST', `${sessionPath}/heartbeat`), 403, 'FORBIDDEN');

		await deps.services.projects.removeMember(pid, user, ACTOR);
		await expectError(await request('GET', sessionPath), 404, 'NOT_FOUND');
		await expectError(await request('GET', `/projects/${pid}/sessions`), 404, 'NOT_FOUND');
	});

	it('does not disclose links through anonymous requests or another notebook path', async () => {
		const { request, bucket, pid, path, seedSession } = await setup();
		const session = await seedSession();
		await expectError(
			await request(
				'GET',
				`/projects/${pid}/notebooks/${createNotebookId()}/sessions/${session.session_id}`,
			),
			404,
			'NOT_FOUND',
		);
		const anonymous = createTestApi({
			bucket,
			deps: { theme, authenticator: { authenticate: async () => null } },
		});
		await expectError(
			await anonymous.request('GET', `${path}/${session.session_id}`),
			401,
			'UNAUTHORIZED',
		);
		expect(await expectOk(await anonymous.request('GET', '/theme'))).toEqual(DEFAULT_THEME_CONFIG);
	});

	it('uses each deployment configuration when reading the same stored session', async () => {
		const { request, bucket, path, seedSession } = await setup();
		const session = await seedSession();
		const replacement = createTestApi({
			bucket,
			deps: {
				theme: {
					...theme,
					session_links: [
						{ id: 'new', label: 'New console', href_template: 'https://new.example/{session_id}' },
					],
				},
			},
		});
		const disabled = createTestApi({ bucket, deps: { theme: { ...theme, session_links: [] } } });
		const sessionPath = `${path}/${session.session_id}`;
		const [original, changed, removed] = await Promise.all([
			request('GET', sessionPath),
			replacement.request('GET', sessionPath),
			disabled.request('GET', sessionPath),
		]);
		expect((await expectOk(original)).links[0].id).toBe('lookout');
		expect((await expectOk(changed)).links).toEqual([
			{ id: 'new', label: 'New console', href: `https://new.example/${session.session_id}` },
		]);
		expect(await expectOk(removed)).not.toHaveProperty('links');
	});

	it('resolves links on create, reuse, get, list, and heartbeat without storing them', async () => {
		const { request, deps, pid, nid, path } = await setup();
		const created = await expectOk<SessionCreateResult>(await request('POST', path));
		const stored = await deps.services.sessions.getSession(
			pid,
			SessionId.parse(created.session_id),
		);
		const links = [
			{
				id: 'lookout',
				label: 'Lookout',
				href: `https://lookout.example/${pid}/${nid}?jobSet=${stored.sandbox_id}&session=${created.session_id}`,
			},
		];
		expect(created.links).toEqual(links);
		expect(stored).not.toHaveProperty('links');
		const reused = await expectOk(await request('POST', path));
		expect(reused).toMatchObject({ reused: true, links });
		const fetched = await expectOk(await request('GET', `${path}/${created.session_id}`));
		expect(fetched.links).toEqual(links);
		expect(fetched).not.toHaveProperty('sandbox_id');
		expect(fetched).not.toHaveProperty('href_template');
		expect(await expectPage(await request('GET', `/projects/${pid}/sessions`))).toEqual([
			expect.objectContaining({ links }),
		]);
		const heartbeat = await expectOk(
			await request('POST', `${path}/${created.session_id}/heartbeat`),
		);
		expect(heartbeat.links).toEqual(links);
	});

	it('keeps links available before readiness and after failure', async () => {
		const { request, deps, pid, path, seedSession } = await setup();
		const session = await seedSession();
		const starting = await expectOk(await request('GET', `${path}/${session.session_id}`));
		expect(starting.status).toBe('starting');
		expect(starting.links).toHaveLength(1);
		await deps.services.sessions.markFailed(pid, session.session_id, {
			code: 'PROVISION_FAILED',
			message: 'Could not schedule the kernel',
		});
		const failed = await expectOk(await request('GET', `${path}/${session.session_id}`));
		expect(failed.status).toBe('failed');
		expect(failed.links).toEqual(starting.links);
	});

	it('redacts links from callers who can list but cannot attach to an exclusive editor', async () => {
		const { bucket, pid, path, seedSession } = await setup();
		const session = await seedSession({ editor_sandbox_sharing: 'exclusive' });
		const { request } = createTestApi({
			bucket,
			userId: uid('another-editor'),
			deps: { theme, policy: { defaultRole: 'editor' } },
		});
		const fetched = await expectOk(await request('GET', `${path}/${session.session_id}`));
		expect(fetched.can.attach).toBe(false);
		expect(fetched).not.toHaveProperty('links');
		const listed = await expectPage(await request('GET', `/projects/${pid}/sessions`));
		expect(listed).toHaveLength(1);
		expect(listed[0]).not.toHaveProperty('links');
	});

	it('omits links for app sessions and deployments without templates', async () => {
		const { request, bucket, path, seedSession } = await setup();
		const session = await seedSession({ mode: 'app' });
		expect(
			await expectOk(await request('GET', `${path}/${session.session_id}`)),
		).not.toHaveProperty('links');
		const editor = await seedSession();
		const withoutTemplates = createTestApi({ bucket });
		expect(
			await expectOk(await withoutTemplates.request('GET', `${path}/${editor.session_id}`)),
		).not.toHaveProperty('links');
	});
});
