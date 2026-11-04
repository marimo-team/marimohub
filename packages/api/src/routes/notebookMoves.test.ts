import { describe, expect, it, vi } from 'vitest';
import { UserId, ForbiddenError } from '@marimo-hub/core';
import { localResourceSecurity, makeSubjectContext, ACTOR } from '@marimo-hub/core/testing';
import {
	createInitializedBucket,
	createTestApi,
	expectOk,
	expectError,
	stubSourceControl,
} from '../testing';

const GIT_INPUT = {
	title: 'Git',
	description: '',
	repo: 'owner/repo',
	branch: 'main',
	root_path: '',
	entry_notebook: 'app.py',
};

async function setup() {
	const bucket = await createInitializedBucket();
	const api = createTestApi({ bucket });
	const { projects, notebooks } = api.deps.services;
	const source = await projects.createProject({ name: 'Source', description: '' }, ACTOR);
	const destination = await projects.createProject({ name: 'Destination', description: '' }, ACTOR);
	const notebook = await notebooks.createNotebook(
		source.id,
		{ title: 'Notebook', description: '', code: 'print(1)' },
		ACTOR,
	);
	const path = `/projects/${source.id}/notebooks/${notebook.id}/move`;
	const headers = { 'Idempotency-Key': 'move', 'If-Match': `"${notebook.updated_at}"` };
	return { api, bucket, source, destination, notebook, path, headers };
}

describe('POST notebook move', () => {
	it.each(['Idempotency-Key', 'If-Match'] as const)(
		'rejects a missing %s header without moving data',
		async (missing) => {
			const { api, source, destination, notebook, path, headers } = await setup();
			const remaining = { ...headers } as Record<string, string>;
			delete remaining[missing];
			expect(
				(await api.request('POST', path, { destination_project_id: destination.id }, remaining))
					.status,
			).toBe(422);
			expect(await api.deps.services.notebooks.getNotebookContent(source.id, notebook.id)).toBe(
				'print(1)',
			);
			expect(await api.deps.services.notebooks.listNotebooks(destination.id)).toEqual([]);
		},
	);

	it('does not replay a completed move after destination manager access is revoked', async () => {
		const { api, bucket, source, destination, notebook, path, headers } = await setup();
		const userId = UserId.parse('manager');
		for (const project of [source, destination]) {
			await api.deps.services.projects.addMember(project.id, { user_id: userId }, 'manager', ACTOR);
		}
		const manager = createTestApi({ bucket, userId });
		await expectOk(
			await manager.request('POST', path, { destination_project_id: destination.id }, headers),
		);
		await api.deps.services.projects.removeMember(destination.id, userId, ACTOR);
		const response = await manager.request(
			'POST',
			path,
			{ destination_project_id: destination.id },
			headers,
		);
		expect([403, 404]).toContain(response.status);
		expect(await api.deps.services.notebooks.getNotebookContent(destination.id, notebook.id)).toBe(
			'print(1)',
		);
	});

	it.each(['pending', 'historical'] as const)(
		'checks destination policy for %s Git repositories',
		async (revision) => {
			const { api, bucket, source, destination } = await setup();
			const { notebooks } = api.deps.services;
			const { meta } = await notebooks.synced.create(
				source.id,
				{ ...GIT_INPUT, repo: 'restricted/repo' },
				ACTOR,
			);
			const sync = async (repo: string) =>
				notebooks.synced.sync(source.id, meta.id, {
					repo,
					branch: 'main',
					root_path: '',
					commit: repo === 'restricted/repo' ? 'a'.repeat(40) : 'b'.repeat(40),
					files: [{ path: 'app.py', bytes: new TextEncoder().encode('print(42)') }],
				});
			await sync('restricted/repo');
			await notebooks.synced.updateSource(
				source.id,
				meta.id,
				{ repo: 'allowed/repo', branch: 'main', root_path: '', entry_notebook: 'app.py' },
				ACTOR,
			);
			await sync('allowed/repo');
			if (revision === 'pending') {
				await notebooks.synced.updateSource(
					source.id,
					meta.id,
					{ repo: 'pending/repo', branch: 'main', root_path: '', entry_notebook: 'app.py' },
					ACTOR,
				);
			}
			const denied = revision === 'pending' ? 'pending/repo' : 'restricted/repo';
			const authorize = vi.fn((_provider: string, repo: string) => {
				if (repo === denied) throw new ForbiddenError('Repository not allowed');
			});
			const restricted = createTestApi({
				bucket,
				deps: {
					sourceControl: { ...stubSourceControl(), assertRepositoryAllowed: authorize },
				},
			});
			const before = await notebooks.getNotebook(source.id, meta.id);
			await expectError(
				await restricted.request(
					'POST',
					`/projects/${source.id}/notebooks/${meta.id}/move`,
					{ destination_project_id: destination.id },
					{ 'Idempotency-Key': 'git-policy', 'If-Match': `"${before.meta.updated_at}"` },
				),
				403,
				'FORBIDDEN',
			);
			expect(authorize).toHaveBeenCalledWith('github', denied, destination.id);
			expect(await notebooks.getNotebook(source.id, meta.id)).toEqual(before);
			expect(await notebooks.listNotebooks(destination.id)).toEqual([]);
		},
	);

	it('leaves a pull notebook in its source when destination credentials cannot read the branch', async () => {
		const { api, bucket, source, destination } = await setup();
		const { notebooks } = api.deps.services;
		const { meta } = await notebooks.synced.create(
			source.id,
			{ ...GIT_INPUT, sync_mode: 'pull' },
			ACTOR,
		);
		const getBranchHead = vi.fn(async () => {
			throw new ForbiddenError('Branch access denied');
		});
		const reader = {
			provider: 'github',
			supportsRepository: () => true,
			getBranchHead,
			fetchWorkspace: async () => [],
			fetchGitDirectory: async () => [],
		};
		const restricted = createTestApi({
			bucket,
			deps: { sourceControl: stubSourceControl({ reader }) },
		});
		await expectError(
			await restricted.request(
				'POST',
				`/projects/${source.id}/notebooks/${meta.id}/move`,
				{ destination_project_id: destination.id },
				{ 'Idempotency-Key': 'pull-failed', 'If-Match': `"${meta.updated_at}"` },
			),
			403,
			'FORBIDDEN',
		);
		expect(getBranchHead).toHaveBeenCalled();
		expect((await notebooks.getNotebook(source.id, meta.id)).meta).toEqual(meta);
		expect(await notebooks.listNotebooks(destination.id)).toEqual([]);
	});

	it('moves a notebook for a manager of both projects', async () => {
		const { api, bucket, source, destination, notebook, path, headers } = await setup();
		const userId = UserId.parse('manager');
		for (const project of [source, destination])
			await api.deps.services.projects.addMember(project.id, { user_id: userId }, 'manager', ACTOR);
		const manager = createTestApi({ bucket, userId });
		await expectOk(
			await manager.request('POST', path, { destination_project_id: destination.id }, headers),
		);
		await expectError(
			await manager.request('GET', `/projects/${source.id}/notebooks/${notebook.id}`),
			404,
			'NOT_FOUND',
		);
		await expectOk(
			await manager.request('GET', `/projects/${destination.id}/notebooks/${notebook.id}`),
		);
	});

	it.each(['source', 'destination'] as const)(
		'rejects editor-only access in the %s project',
		async (side) => {
			const { api, bucket, source, destination, path, headers } = await setup();
			const userId = UserId.parse('editor');
			await api.deps.services.projects.addMember(
				source.id,
				{ user_id: userId },
				side === 'source' ? 'editor' : 'manager',
				ACTOR,
			);
			await api.deps.services.projects.addMember(
				destination.id,
				{ user_id: userId },
				side === 'destination' ? 'editor' : 'manager',
				ACTOR,
			);
			const editor = createTestApi({ bucket, userId });
			await expectError(
				await editor.request('POST', path, { destination_project_id: destination.id }, headers),
				403,
				'FORBIDDEN',
			);
		},
	);

	it('requires an idempotency key and notebook precondition', async () => {
		const { api, destination, path, headers } = await setup();
		const body = { destination_project_id: destination.id };
		expect((await api.request('POST', path, body)).status).toBe(422);
		await expectError(
			await api.request('POST', path, body, { ...headers, 'If-Match': '"old"' }),
			412,
			'PRECONDITION_FAILED',
		);
	});

	it('keeps push Git sources and history without retaining the old sync token', async () => {
		const { api, source, destination } = await setup();
		const { notebooks } = api.deps.services;
		const { meta, sync_token } = await notebooks.synced.create(source.id, GIT_INPUT, ACTOR);
		await notebooks.synced.sync(source.id, meta.id, {
			repo: 'owner/repo',
			branch: 'main',
			root_path: '',
			commit: 'abc',
			files: [{ path: 'app.py', bytes: new TextEncoder().encode('print(42)') }],
		});
		const before = await notebooks.getNotebook(source.id, meta.id);
		const versions = await notebooks.listVersions(source.id, meta.id);
		await expectOk(
			await api.request(
				'POST',
				`/projects/${source.id}/notebooks/${meta.id}/move`,
				{ destination_project_id: destination.id },
				{ 'Idempotency-Key': 'git', 'If-Match': `"${before.meta.updated_at}"` },
			),
		);
		expect((await notebooks.getNotebook(destination.id, meta.id)).source).toEqual(before.source);
		expect(await notebooks.listVersions(destination.id, meta.id)).toEqual(versions);
		expect(await notebooks.synced.verifyToken(source.id, meta.id, sync_token)).toBe(false);
		expect(await notebooks.synced.verifyToken(destination.id, meta.id, sync_token)).toBe(false);
		const rotated = await notebooks.synced.rotateToken(destination.id, meta.id);
		expect(await notebooks.synced.verifyToken(destination.id, meta.id, rotated.sync_token)).toBe(
			true,
		);
	});

	it('applies destination repository policy to push sources without a reader', async () => {
		const { api, bucket, source, destination } = await setup();
		const { meta } = await api.deps.services.notebooks.synced.create(source.id, GIT_INPUT, ACTOR);
		const authorize = vi.fn(() => {
			throw new ForbiddenError('Repository not allowed');
		});
		const restricted = createTestApi({
			bucket,
			deps: {
				sourceControl: {
					...stubSourceControl(),
					assertRepositoryAllowed: authorize,
				},
			},
		});
		await expectError(
			await restricted.request(
				'POST',
				`/projects/${source.id}/notebooks/${meta.id}/move`,
				{ destination_project_id: destination.id },
				{ 'Idempotency-Key': 'git-policy', 'If-Match': `"${meta.updated_at}"` },
			),
			403,
			'FORBIDDEN',
		);
		expect(authorize).toHaveBeenCalledWith('github', 'owner/repo', destination.id);
	});
	it('hides notebooks from a manager without the required security context', async () => {
		const { api, bucket, source, destination, notebook, path, headers } = await setup();
		await api.deps.services.notebooks.setSecurityLabels(
			source.id,
			notebook.id,
			{ classification: 'SECRET', compartments: ['element-a'] },
			ACTOR,
		);
		const restricted = createTestApi({
			bucket,
			deps: {
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ classification: 'UNCLASSIFIED', compartments: [] }),
				),
			},
		});
		await expectError(
			await restricted.request('POST', path, { destination_project_id: destination.id }, headers),
			404,
			'NOT_FOUND',
		);
	});

	it('rejects moves that would drop inherited project security labels', async () => {
		const { api, bucket, source, destination, path, headers } = await setup();
		await api.deps.services.projects.setSecurityLabels(
			source.id,
			{ classification: 'SECRET', compartments: ['element-a'] },
			ACTOR,
		);
		const labeled = createTestApi({
			bucket,
			deps: {
				resourceSecurity: localResourceSecurity(['UNCLASSIFIED', 'SECRET'], makeSubjectContext()),
			},
		});
		await expectError(
			await labeled.request('POST', path, { destination_project_id: destination.id }, headers),
			422,
			'VALIDATION_ERROR',
		);
		await api.deps.services.projects.setSecurityLabels(
			destination.id,
			{ classification: 'SECRET', compartments: ['element-a'] },
			ACTOR,
		);
		await expectOk(
			await labeled.request('POST', path, { destination_project_id: destination.id }, headers),
		);
	});

	it('does not let a source-scoped API token move into another project', async () => {
		const { bucket, source, destination, path, headers } = await setup();
		const scoped = createTestApi({
			bucket,
			subject: {
				credential: {
					kind: 'personal-access-token',
					grant: { actions: '*', projects: [source.id] },
				},
			},
		});
		expect(
			(await scoped.request('POST', path, { destination_project_id: destination.id }, headers))
				.status,
		).not.toBe(200);
	});

	it('lists only managed projects for the destination picker', async () => {
		const { api, bucket, source, destination } = await setup();
		const userId = UserId.parse('editor');
		await api.deps.services.projects.addMember(source.id, { user_id: userId }, 'editor', ACTOR);
		await api.deps.services.projects.addMember(
			destination.id,
			{ user_id: userId },
			'manager',
			ACTOR,
		);
		const member = createTestApi({ bucket, userId });
		const result = await expectOk<{ items: { id: string }[] }>(
			await member.request('GET', '/projects?managed_only=true'),
		);
		expect(result.items.map((item) => item.id)).toEqual([destination.id]);
	});

	it('validates pull access in the destination without changing the pinned commit', async () => {
		const { api, bucket, source, destination } = await setup();
		const { meta } = await api.deps.services.notebooks.synced.create(
			source.id,
			{ ...GIT_INPUT, sync_mode: 'pull' },
			ACTOR,
		);
		const getBranchHead = vi.fn(async () => ({ commit: 'b'.repeat(40) }));
		const reader = {
			provider: 'github',
			supportsRepository: () => true,
			getBranchHead,
			fetchWorkspace: async () => [],
			fetchGitDirectory: async () => [],
		};
		const getReader = vi.fn(() => reader);
		const pull = createTestApi({
			bucket,
			deps: { sourceControl: { ...stubSourceControl({ reader }), getReader } },
		});
		await expectOk(
			await pull.request(
				'POST',
				`/projects/${source.id}/notebooks/${meta.id}/move`,
				{ destination_project_id: destination.id },
				{ 'Idempotency-Key': 'pull', 'If-Match': `"${meta.updated_at}"` },
			),
		);
		expect(getReader).toHaveBeenCalledWith('github', destination.id);
		expect(getBranchHead).toHaveBeenCalled();
		expect(
			await api.deps.services.notebooks.getNotebookSource(destination.id, meta.id),
		).toMatchObject({ type: 'git', sync_mode: 'pull', commit: null });
	});
});
