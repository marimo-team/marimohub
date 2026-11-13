import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTOR, setupTestEnv, makeVersion } from '../../testing';
import { paths } from '../../paths';
import { ConflictError } from '../../errors';
import { publicationArtifactKey } from './localPublication';
import { NotebookService } from './NotebookService';
import { CatalogService } from '../catalog/CatalogService';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const env = await setupTestEnv();
	const project = await env.projects.createProject({ name: 'Publication', description: '' }, ACTOR);
	const notebook = await env.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: '# initial' },
		ACTOR,
	);
	const nb = paths.project(project.id).notebook(notebook.id);
	const token = () => env.notebooks.beginSessionCapture(project.id, notebook.id);
	const commit = (
		input: Parameters<typeof env.notebooks.commitSession>[2],
		capture?: Awaited<ReturnType<typeof token>>,
	) => env.notebooks.commitSession(project.id, notebook.id, input, ACTOR, capture);
	const successor = new NotebookService(env.bucket, new CatalogService(env.bucket));
	return { ...env, project, notebook, nb, token, commit, successor };
}

describe('local publication fencing', () => {
	it.each(['source', 'outputs'] as const)(
		'rejects a delayed older %s publication',
		async (kind) => {
			const env = await fixture();
			const token = await env.token();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const put = env.bucket.put.bind(env.bucket);
			let blocked = false;
			vi.spyOn(env.bucket, 'put').mockImplementation(async (key, body, opts) => {
				if (key === env.nb.source && !blocked) {
					blocked = true;
					entered.resolve();
					await release.promise;
				}
				return put(key, body, opts);
			});
			const older = env.commit(
				{ code: kind === 'source' ? '# old' : '# initial', session: '{"output":"old"}' },
				token,
			);
			try {
				await entered.promise;
				const newer = await env.successor.commitSession(
					env.project.id,
					env.notebook.id,
					{ code: kind === 'source' ? '# new' : '# initial', session: '{"output":"new"}' },
					ACTOR,
				);
				release.resolve();
				await expect(older).rejects.toBeInstanceOf(ConflictError);
				const current = await env.token();
				expect(current.source.current_version_id).toBe(newer!.versionId);
				const descriptor = current.versions.find(
					(version) => version.version_id === newer!.versionId,
				)!.session_snapshot;
				const key = publicationArtifactKey(
					env.project.id,
					env.notebook.id,
					newer!.versionId,
					'session',
					descriptor,
				);
				expect(await (await env.bucket.get(key))!.text()).toBe('{"output":"new"}');
			} finally {
				release.resolve();
				await older.catch(() => {});
			}
		},
	);

	it('invalidates a captured token on editor handover', async () => {
		const env = await fixture();
		const token = await env.token();
		await env.notebooks.fenceSessionPublications(env.project.id, env.notebook.id);
		await expect(env.commit({ code: '# stale' }, token)).rejects.toBeInstanceOf(ConflictError);
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# initial',
		);
	});

	it('repairs missing immutable dependencies and artifacts instead of reporting a false no-op', async () => {
		const env = await fixture();
		const first = await env.commit({ code: '# initial', session: '{}' });
		const token = await env.token();
		const descriptor = token.versions[0].session_snapshot;
		const key = publicationArtifactKey(
			env.project.id,
			env.notebook.id,
			first!.versionId,
			'session',
			descriptor,
		);
		await env.bucket.delete(key);
		await env.commit({ code: '# initial', session: '{}' });
		const repaired = await env.token();
		expect(repaired.versions[0].session_snapshot?.capture_id).not.toBe(descriptor?.capture_id);
		await env.bucket.delete(env.nb.version(first!.versionId).deps);
		const complete = await env.commit({ code: '# initial', session: '{}' });
		expect(complete).toMatchObject({ newVersion: true });
		expect(await env.bucket.get(env.nb.version(complete!.versionId).deps)).not.toBeNull();
	});

	it('reads committed source through a stale or missing mutable workspace mirror', async () => {
		const env = await fixture();
		await env.commit({ code: '# durable', deps: '[project]\nname="durable"' });
		await env.bucket.delete([env.nb.code, env.nb.deps]);
		expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
			'# durable',
		);
		const entry = await env.notebooks.workspace.read(
			env.project.id,
			env.notebook.id,
			'notebook.py',
		);
		expect(entry).toBeDefined();
	});

	it('fences duplicate captures without uploading duplicate artifacts', async () => {
		const env = await fixture();
		await env.commit({ code: '# initial', session: '{}' });
		const put = vi.spyOn(env.bucket, 'put');
		await env.commit({ code: '# initial', session: '{}' });
		expect(
			put.mock.calls.filter(([key]) => key.startsWith(env.nb.base)).map(([key]) => key),
		).toEqual([env.nb.source]);
	});

	it('fences a dispatched changed capture when the latest runtime capture is unchanged', async () => {
		const env = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = env.bucket.put.bind(env.bucket);
		let blocked = false;
		vi.spyOn(env.bucket, 'put').mockImplementation(async (key, body, opts) => {
			if (key === env.nb.source && !blocked) {
				blocked = true;
				entered.resolve();
				await release.promise;
			}
			return put(key, body, opts);
		});
		const older = env.commit({ code: '# old' });
		try {
			await entered.promise;
			await env.successor.commitSession(
				env.project.id,
				env.notebook.id,
				{ code: '# initial' },
				ACTOR,
			);
			release.resolve();
			await expect(older).rejects.toBeInstanceOf(ConflictError);
			expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
				'# initial',
			);
		} finally {
			release.resolve();
			await older.catch(() => {});
		}
	});

	it('retains committed history while collecting failed capture staging', async () => {
		const env = await fixture();
		const token = await env.token();
		await env.commit({ code: '# new', session: '{}' });
		await expect(
			env.commit({ code: '# stale', session: '{"stale":true}' }, token),
		).rejects.toBeInstanceOf(ConflictError);
		await env.notebooks.pruneVersionsAfterMove(env.project.id, env.notebook.id);
		const current = await env.token();
		expect(await env.notebooks.listVersions(env.project.id, env.notebook.id)).toHaveLength(2);
		const objects = await env.bucket.list({ prefix: `${env.nb.base}/versions/` });
		const allowed = new Set(current.versions.map((version) => version.version_id));
		for (const object of objects.objects)
			expect(allowed.has(object.key.split('/versions/')[1].split('/')[0] as never)).toBe(true);
	});

	it('fences a staged capture before GC deletes its candidate files', async () => {
		const env = await fixture();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const put = env.bucket.put.bind(env.bucket);
		let paused = false;
		vi.spyOn(env.bucket, 'put').mockImplementation(async (key, body, opts) => {
			const result = await put(key, body, opts);
			if (key.includes('/captures/') && !paused) {
				paused = true;
				entered.resolve();
				await resume.promise;
			}
			return result;
		});
		const delayed = env.commit({ code: '# pending', session: '{}' });
		try {
			await entered.promise;
			await env.successor.pruneVersionsAfterMove(env.project.id, env.notebook.id);
			resume.resolve();
			await expect(delayed).rejects.toBeInstanceOf(ConflictError);
			expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe(
				'# initial',
			);
		} finally {
			resume.resolve();
			await delayed.catch(() => {});
		}
	});

	it('does not delete a newer capture when an older GC deletion is delayed', async () => {
		const env = await fixture();
		await env.commit({ code: '# initial', session: '{"value":1}' });
		await env.commit({ code: '# initial', session: '{"value":2}' });
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const remove = env.bucket.delete.bind(env.bucket);
		let paused = false;
		vi.spyOn(env.bucket, 'delete').mockImplementation(async (keys) => {
			if (
				!paused &&
				(Array.isArray(keys) ? keys : [keys]).some((key) => key.includes('/captures/'))
			) {
				paused = true;
				entered.resolve();
				await resume.promise;
			}
			return remove(keys);
		});
		const gc = env.notebooks.pruneVersionsAfterMove(env.project.id, env.notebook.id);
		try {
			await entered.promise;
			await env.successor.commitSession(
				env.project.id,
				env.notebook.id,
				{ code: '# initial', session: '{"value":3}' },
				ACTOR,
			);
			const head = await env.token();
			const key = publicationArtifactKey(
				env.project.id,
				env.notebook.id,
				head.source.current_version_id,
				'session',
				head.versions[0].session_snapshot,
			);
			resume.resolve();
			await gc;
			expect(await (await env.bucket.get(key))!.text()).toBe('{"value":3}');
		} finally {
			resume.resolve();
			await gc;
		}
	});
});

it('does not publish an unreadable legacy head and can migrate after bounded retention', async () => {
	const env = await fixture();
	const source = await env.notebooks.getNotebookSource(env.project.id, env.notebook.id);
	await env.bucket.put(
		env.nb.source,
		JSON.stringify({
			schema_version: 1,
			type: 'local',
			current_version_id: source.current_version_id,
		}),
	);
	const { createVersionId } = await import('../../ids');
	for (let index = 0; index < 1000; index++) {
		const id = createVersionId();
		await env.bucket.put(env.nb.version(id).meta, JSON.stringify(makeVersion({ version_id: id })));
	}
	const before = await (await env.bucket.get(env.nb.source))!.text();
	await expect(env.token()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
	expect(await (await env.bucket.get(env.nb.source))!.text()).toBe(before);
	await env.notebooks.pruneVersionsAfterMove(env.project.id, env.notebook.id);
	expect((await env.token()).versions.length).toBeLessThanOrEqual(1000);
	expect(await env.notebooks.getNotebookContent(env.project.id, env.notebook.id)).toBe('# initial');
});
