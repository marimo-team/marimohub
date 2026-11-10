import { describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { createPreviewId, NotebookId, UserId } from '@marimo-hub/core';
import { ACTOR, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { createTestApi, expectError, expectOk } from '../testing';
import { workingBranchFixture } from '../testing/workingBranches';
import { toSessionResponse } from './sessions';

async function setup() {
	const env = await workingBranchFixture();
	const path = `/projects/${env.project.id}/notebooks`;
	const created = await expectOk(
		await env.request('POST', `${path}/git`, env.createBody, { 'Idempotency-Key': 'create' }),
		201,
	);
	const nid = NotebookId.parse(created.notebook.id);
	const sid = await env.session(nid);
	return { ...env, nid, sid, path: `${path}/${nid}` };
}

describe('working branch routes', { timeout: 30000 }, () => {
	it('requires the feature and key, and permits editors to create a branch', async () => {
		const env = await workingBranchFixture();
		const path = `/projects/${env.project.id}/notebooks/git`;
		await expectError(await env.request('POST', path, env.createBody), 400);
		const editor = UserId.parse('editor');
		await env.deps.services.projects.addMember(
			env.project.id,
			{ user_id: editor },
			'editor',
			ACTOR,
		);
		const api = createTestApi({
			bucket: env.bucket,
			userId: editor,
			deps: { sourceControl: env.sourceControl },
		});
		const created = await expectOk(
			await api.request('POST', path, env.createBody, { 'Idempotency-Key': 'one' }),
			201,
		);
		expect(
			(
				await expectOk(
					await api.request('POST', path, env.createBody, { 'Idempotency-Key': 'one' }),
					201,
				)
			).notebook.id,
		).toBe(created.notebook.id);
		expect(env.writer.createBranch).toHaveBeenCalledTimes(1);
		await expectError(
			await api.request('POST', path, { ...env.createBody, fork: undefined, branch: 'main' }),
			403,
		);
		const disabled = createTestApi({ bucket: env.bucket });
		await expectError(
			await disabled.request('POST', path, env.createBody, { 'Idempotency-Key': 'disabled' }),
			503,
		);
	});
	it('hides creation replay after notebook security labels change', async () => {
		const env = await workingBranchFixture();
		const api = createTestApi({
			bucket: env.bucket,
			deps: {
				sourceControl: env.sourceControl,
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ classification: 'UNCLASSIFIED', compartments: [] }),
				),
			},
		});
		const path = `/projects/${env.project.id}/notebooks`;
		const create = () =>
			api.request('POST', `${path}/git`, env.createBody, { 'Idempotency-Key': 'create' });
		const created = await expectOk(await create(), 201);
		const nid = NotebookId.parse(created.notebook.id);
		await env.deps.services.notebooks.setSecurityLabels(
			env.project.id,
			nid,
			{ classification: 'SECRET', compartments: ['finance'] },
			ACTOR,
		);
		await expectError(await api.request('GET', `${path}/${nid}`), 404);
		await expectError(await create(), 404);
		expect(env.writer.createBranch).toHaveBeenCalledTimes(1);
	});
	it('revalidates editor access after provider reads and before creating a branch', async () => {
		const env = await workingBranchFixture();
		const editor = UserId.parse('editor');
		await env.deps.services.projects.addMember(
			env.project.id,
			{ user_id: editor },
			'editor',
			ACTOR,
		);
		const original = env.reader.fetchWorkspace;
		vi.mocked(env.reader.fetchWorkspace).mockImplementationOnce(async (...args) => {
			await env.deps.services.projects.removeMember(env.project.id, editor, ACTOR);
			return original(...args);
		});
		const api = createTestApi({
			bucket: env.bucket,
			userId: editor,
			deps: { sourceControl: env.sourceControl },
		});
		const response = await api.request(
			'POST',
			`/projects/${env.project.id}/notebooks/git`,
			env.createBody,
			{ 'Idempotency-Key': 'revoked' },
		);
		expect([403, 404]).toContain(response.status);
		expect(env.writer.createBranch).not.toHaveBeenCalled();
	});
	it('revalidates editor access before opening a PR', async () => {
		const env = await setup();
		const editor = UserId.parse('editor');
		await env.deps.services.projects.addMember(
			env.project.id,
			{ user_id: editor },
			'editor',
			ACTOR,
		);
		const original = env.writer.inspectBranch;
		vi.mocked(env.writer.inspectBranch).mockImplementationOnce(async (...args) => {
			await env.deps.services.projects.removeMember(env.project.id, editor, ACTOR);
			return original(...args);
		});
		const api = createTestApi({
			bucket: env.bucket,
			userId: editor,
			deps: { sourceControl: env.sourceControl },
		});
		const response = await api.request('POST', `${env.path}/change-requests`, {});
		expect([403, 404]).toContain(response.status);
		expect(env.writer.openBranchChangeRequest).not.toHaveBeenCalled();
	});
	it('saves, exposes safe receipts, downloads capture and opens a draft PR', async () => {
		const env = await setup();
		const launched = await env.deps.services.sessions.getSession(env.project.id, env.sid);
		env.edit('changed');
		const receipt = await expectOk(
			await env.request(
				'POST',
				`${env.path}/sessions/${env.sid}/saves`,
				{ message: 'Update app' },
				{ 'Idempotency-Key': 'save' },
			),
		);
		expect(receipt.state).toBe('complete');
		for (const [method, suffix] of [
			['GET', ''],
			['POST', '/heartbeat'],
		]) {
			const session = await expectOk(
				await env.request(method, `${env.path}/sessions/${env.sid}${suffix}`),
			);
			expect(session.source_version_id).toBe(launched.source_version_id);
			expect(session.working_branch_version_id).toBe(receipt.version_id);
			expect(session.working_branch_version_id).not.toBe(session.source_version_id);
		}

		const savedSession = await env.deps.services.sessions.getSession(env.project.id, env.sid);
		const grants = {
			role: 'editor' as const,
			attach: true,
			stop: true,
			surface: true,
			appReadOnly: false,
		};
		const appOnly = toSessionResponse(savedSession, { ...grants, appReadOnly: true });
		const preview = toSessionResponse(
			{
				...savedSession,
				origin: {
					type: 'preview',
					notebook_id: env.nid,
					preview_id: createPreviewId(),
					revision_id: savedSession.working_branch_version_id!,
					commit: 'a'.repeat(40),
				},
			},
			grants,
		);
		for (const hidden of [appOnly, preview]) {
			expect(hidden.source_version_id).toBeUndefined();
			expect(hidden.working_branch_version_id).toBeUndefined();
		}
		expect(receipt).not.toHaveProperty('fingerprint');
		expect(receipt).not.toHaveProperty('co_author');
		expect(
			(await expectOk(await env.request('GET', `${env.path}/working-branch`))).last_save.id,
		).toBe(receipt.id);
		expect(
			(await expectOk(await env.request('GET', `${env.path}/saves/${receipt.id}`))).commit,
		).toBe(receipt.commit);
		const archive = await env.request('GET', `${env.path}/saves/${receipt.id}/recovery`);
		expect(archive.headers.get('content-type')).toBe('application/zip');
		expect(
			new TextDecoder().decode(
				unzipSync(new Uint8Array(await archive.arrayBuffer()))['files/app.py'],
			),
		).toBe('changed');
		const pr = await expectOk(await env.request('POST', `${env.path}/change-requests`, {}));
		expect(pr.number).toBe(42);
		expect(env.writer.openBranchChangeRequest).toHaveBeenCalledWith(
			expect.objectContaining({ draft: true, baseBranch: 'main' }),
		);
	});
	it('resumes a lost update by receipt ID without recapturing later edits', async () => {
		const env = await setup();
		env.edit('captured');
		vi.mocked(env.writer.advanceBranch).mockImplementationOnce(async ({ commit }) => {
			env.setHead(commit);
			throw new Error('lost response');
		});
		const pending = await expectOk(
			await env.request(
				'POST',
				`${env.path}/sessions/${env.sid}/saves`,
				{},
				{ 'Idempotency-Key': 'save' },
			),
		);
		expect(pending.state).toBe('ref_dispatched');
		env.edit('later');
		const done = await expectOk(await env.request('POST', `${env.path}/saves/${pending.id}/retry`));
		expect(done.state).toBe('complete');
		expect(env.writer.prepareCommit).toHaveBeenCalledTimes(1);
		expect(env.writer.advanceBranch).toHaveBeenCalledTimes(1);
		expect(new TextDecoder().decode(env.snapshots.get(done.commit)!.get('app.py'))).toBe(
			'captured',
		);
	});
	it('requires the new token grant and rejects the legacy proposal path', async () => {
		const env = await setup();
		const token = (actions: ('working-branch.write' | 'notebook.write')[]) =>
			createTestApi({
				bucket: env.bucket,
				subject: {
					credential: {
						kind: 'personal-access-token',
						grant: { actions, projects: [env.project.id] },
					},
				},
				deps: { sourceControl: env.sourceControl },
			});
		await expectError(
			await token(['notebook.write']).request('GET', `${env.path}/working-branch`),
			403,
		);
		await expectOk(
			await token(['working-branch.write']).request('GET', `${env.path}/working-branch`),
		);
		await expectError(
			await env.request(
				'POST',
				`${env.path}/sessions/${env.sid}/change-requests`,
				{},
				{ 'Idempotency-Key': 'old' },
			),
			409,
		);
		expect(env.writer.prepareCommit).not.toHaveBeenCalled();
	});
	it('denies viewers and mismatched sessions before provider writes', async () => {
		const env = await setup();
		env.edit('private');
		const viewer = UserId.parse('viewer');
		await env.deps.services.projects.addMember(
			env.project.id,
			{ user_id: viewer },
			'viewer',
			ACTOR,
		);
		const api = createTestApi({
			bucket: env.bucket,
			userId: viewer,
			deps: { sourceControl: env.sourceControl },
		});
		await expectError(
			await api.request(
				'POST',
				`${env.path}/sessions/${env.sid}/saves`,
				{},
				{ 'Idempotency-Key': 'save' },
			),
			403,
		);
		await expectError(await api.request('GET', `${env.path}/working-branch`), 403);
		const other = await env.deps.services.notebooks.createNotebook(
			env.project.id,
			{ title: 'Other', description: '', code: '' },
			ACTOR,
		);
		await expectError(
			await env.request(
				'POST',
				`/projects/${env.project.id}/notebooks/${other.id}/sessions/${env.sid}/saves`,
				{},
				{ 'Idempotency-Key': 'save' },
			),
			404,
		);
		expect(env.writer.prepareCommit).not.toHaveBeenCalled();
	});
});
