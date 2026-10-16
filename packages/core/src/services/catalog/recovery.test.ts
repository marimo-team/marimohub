import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import {
	ACTOR,
	makeNotebookMeta,
	makeProject,
	makeSnapshot,
	makeSnapshotProjectEntry,
} from '../../testing/fixtures';
import { createServices } from '../index';
import { createImportId, createNotebookId, createSnapshotId } from '../../ids';
import { PreconditionFailedError } from '../../errors';
import { paths } from '../../paths';
import { CatalogService } from './CatalogService';
import type { CatalogRecoveryReport } from './recovery';
import { listAllObjects } from './storage';

const SOURCE = { mode: 'rebuild' } as const;
const INPUT = { title: 'Recovered notebook', description: '', code: 'print(1)' };

function applyRecovery(catalog: CatalogService, report: CatalogRecoveryReport) {
	return catalog.recover(report.source, ACTOR, {
		token: report.token,
		writersStopped: true,
		acceptWarnings: true,
	});
}

async function fixture() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const project = await services.projects.createProject(
		{ name: 'Original', description: '' },
		ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(project.id, INPUT, ACTOR);
	return { bucket, services, project, notebook };
}

function freshCatalog(bucket: MemoryBucket) {
	return new CatalogService(bucket, undefined, undefined, undefined, 0);
}

async function eraseIndex(bucket: MemoryBucket) {
	await bucket.delete(
		(await listAllObjects(bucket, paths.snapshotsPrefix)).map((object) => object.key),
	);
	await bucket.delete(paths.catalog);
}

describe('catalog recovery', () => {
	it.each(['projects', 'snapshots'])('refuses initialization when only %s remain', async (kind) => {
		const bucket = new MemoryBucket();
		const project = makeProject();
		const snapshot = makeSnapshot();
		await bucket.put(
			kind === 'projects' ? paths.project(project.id).meta : paths.snapshot(snapshot.snapshot_id),
			JSON.stringify(kind === 'projects' ? project : snapshot),
		);
		const put = vi.spyOn(bucket, 'put');
		await expect(freshCatalog(bucket).initialize(ACTOR)).rejects.toThrow(
			'Catalog recovery required',
		);
		expect(put).not.toHaveBeenCalled();
	});

	it('lets a second replica initialize while the first has written only its snapshot', async () => {
		const bucket = new MemoryBucket();
		const first = freshCatalog(bucket);
		const second = freshCatalog(bucket);
		const put = bucket.put.bind(bucket);
		let secondResult: Promise<unknown> | undefined;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.catalog && !secondResult) {
				secondResult = second.initialize(ACTOR);
				await secondResult;
			}
			return put(key, value, options);
		});
		const committed = await first.initialize(ACTOR);
		expect(await secondResult).toEqual(committed);
		expect(await listAllObjects(bucket, paths.snapshotsPrefix)).toHaveLength(1);
	});

	it('boots over an empty initialize snapshot orphaned by a crash', async () => {
		const bucket = new MemoryBucket();
		const orphan = makeSnapshot({ operation: 'system.initialize' });
		await bucket.put(paths.snapshot(orphan.snapshot_id), JSON.stringify(orphan));
		const snapshot = await freshCatalog(bucket).initialize(ACTOR);
		expect(snapshot.snapshot_id).not.toBe(orphan.snapshot_id);
		expect(await bucket.head(paths.snapshot(orphan.snapshot_id))).not.toBeNull();
	});

	it('requires recovery for an initialize snapshot that indexes projects', async () => {
		const bucket = new MemoryBucket();
		const snapshot = makeSnapshot({
			operation: 'system.initialize',
			projects: [makeSnapshotProjectEntry()],
		});
		await bucket.put(paths.snapshot(snapshot.snapshot_id), JSON.stringify(snapshot));
		await expect(freshCatalog(bucket).initialize(ACTOR)).rejects.toThrow(
			'Catalog recovery required',
		);
	});

	it('returns the catalog another replica commits during the recheck delay', async () => {
		const { bucket, services } = await fixture();
		const current = await services.catalog.getCurrentSnapshot();
		vi.spyOn(bucket, 'get').mockImplementationOnce(async () => null);
		vi.spyOn(bucket, 'head').mockImplementationOnce(async () => null);
		const snapshot = await freshCatalog(bucket).initialize(ACTOR);
		expect(snapshot.snapshot_id).toBe(current.snapshot_id);
	});

	it('rebuilds projects, notebooks, labels, membership, and scheduled jobs after total index loss', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const job = await services.jobs.createJob(
			project.id,
			notebook.id,
			{ name: 'Daily', schedule: { cron: '0 0 * * *', timezone: 'UTC' } },
			ACTOR,
		);
		const projectMeta = {
			...project,
			members: [{ email: 'Reader@Example.com', role: 'viewer' }],
			security_labels: { classification: 'internal', compartments: ['finance'] },
		};
		await bucket.put(paths.project(project.id).meta, JSON.stringify(projectMeta));
		await eraseIndex(bucket);
		const put = vi.spyOn(bucket, 'put');
		const report = await services.catalog.planRecovery(SOURCE);
		expect(put).not.toHaveBeenCalled();
		expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
		expect(report.projects).toMatchObject([
			{
				id: project.id,
				security_labels: { classification: 'internal', compartments: ['finance'] },
				member_emails: ['reader@example.com'],
				notebook_count: 1,
				notebooks: [{ id: notebook.id, jobs: [{ id: job.id, enabled: true }] }],
			},
		]);
		await applyRecovery(services.catalog, report);
		expect((await services.projects.listProjects()).map((entry) => entry.id)).toEqual([project.id]);
		expect((await services.notebooks.getNotebook(project.id, notebook.id)).meta.id).toBe(
			notebook.id,
		);
		expect((await services.catalog.getCurrentSnapshot()).operation).toBe('system.recover');
		expect(await services.jobs.getJob(project.id, notebook.id, job.id)).toMatchObject({
			id: job.id,
		});
	});

	it('restores selected membership but preserves current deletions and current metadata', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const snapshot = await services.catalog.getCurrentSnapshot();
		await services.notebooks.deleteNotebook(project.id, notebook.id, ACTOR);
		await services.projects.updateProject(project.id, { name: 'Renamed' }, ACTOR);
		await services.projects.createProject({ name: 'Later', description: '' }, ACTOR);
		await bucket.delete(paths.catalog);
		const source = { mode: 'snapshot', snapshotId: snapshot.snapshot_id } as const;
		const report = await services.catalog.planRecovery(source);
		expect(report.projects).toMatchObject([
			{
				id: project.id,
				name: 'Renamed',
				notebook_count: 0,
				notebooks: [{ id: notebook.id, status: 'deleted' }],
			},
		]);
		await applyRecovery(services.catalog, report);
		expect((await services.catalog.getCurrentSnapshot()).projects).toHaveLength(1);
	});

	it('keeps project tombstones and excludes preview runtimes and uncompleted import attempts', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const stagedId = createNotebookId();
		await services.notebooks.stageImportNotebook(project.id, stagedId, INPUT, ACTOR);
		const receipt = paths.project(project.id).notebookImport(createImportId()).item('entry');
		await bucket.put(
			receipt,
			JSON.stringify({
				actor: ACTOR,
				input: { entry_notebook: 'notebook.py', title: 'Staged' },
				notebook_id: stagedId,
				attempts: [stagedId],
				state: 'publishing',
				lease_until: 0,
			}),
		);
		const previewId = createNotebookId();
		await bucket.put(paths.project(project.id).notebook(previewId).previewMeta, '{}');
		await services.projects.deleteProject(project.id, ACTOR);
		await eraseIndex(bucket);
		const report = await services.catalog.planRecovery(SOURCE);
		expect(report.projects[0].status).toBe('deleted');
		expect(report.projects[0].notebooks.map((entry) => entry.id)).toEqual([notebook.id]);
		expect(report.issues.filter((issue) => issue.severity === 'excluded')).toHaveLength(2);
	});

	it('does not restore jobs with a deletion fence', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const job = await services.jobs.createJob(project.id, notebook.id, { name: 'Deleting' }, ACTOR);
		await bucket.put(paths.jobDeletionClaim(project.id, notebook.id, job.id), '{}');
		const report = await services.catalog.planRecovery(SOURCE);
		expect(report.projects[0].notebooks[0].jobs).toEqual([]);
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				severity: 'excluded',
				key: paths.project(project.id).notebook(notebook.id).job(job.id).head,
			}),
		);
	});

	it('requires explicit warning acceptance and blocks invalid records', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const report = await services.catalog.planRecovery(SOURCE);
		await expect(
			services.catalog.recover(SOURCE, ACTOR, { token: report.token, writersStopped: true }),
		).rejects.toThrow('warnings');
		await bucket.put(paths.project(project.id).notebook(notebook.id).source, '{');
		const broken = await services.catalog.planRecovery(SOURCE);
		const put = vi.spyOn(bucket, 'put');
		await expect(applyRecovery(services.catalog, broken)).rejects.toThrow('blocked');
		expect(put).not.toHaveBeenCalled();
	});

	it.each(['catalog', 'metadata', 'new object'])(
		'rejects a stale report after %s changes',
		async (change) => {
			const { bucket, services, project } = await fixture();
			const report = await services.catalog.planRecovery(SOURCE);
			if (change === 'catalog')
				await services.catalog.mutateSnapshot('test', ACTOR, (snapshot) => snapshot);
			else if (change === 'metadata')
				await bucket.put(
					paths.project(project.id).meta,
					JSON.stringify({ ...project, name: 'Changed' }),
				);
			else await bucket.put(`projects/${project.id}/new-object`, 'changed');
			const put = vi.spyOn(bucket, 'put');
			await expect(applyRecovery(services.catalog, report)).rejects.toThrow('stale');
			expect(put).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])(
		'does not overwrite a competing catalog writer (missing pointer: %s)',
		async (missing) => {
			const { bucket, services } = await fixture();
			if (missing) await bucket.delete(paths.catalog);
			const report = await services.catalog.planRecovery(SOURCE);
			const put = bucket.put.bind(bucket);
			const winner = JSON.stringify({ version: 1, current_snapshot_id: createSnapshotId() });
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === paths.catalog) await put(key, winner);
				return put(key, value, options);
			});
			await expect(applyRecovery(services.catalog, report)).rejects.toThrow('conflict');
			expect(await (await bucket.get(paths.catalog))!.text()).toBe(winner);
		},
	);

	it('retains a committed recovery snapshot if the pointer write response is lost', async () => {
		const { bucket, services } = await fixture();
		await eraseIndex(bucket);
		const report = await services.catalog.planRecovery(SOURCE);
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			const result = await put(key, value, options);
			if (key === paths.catalog) throw new Error('Response lost');
			return result;
		});
		await expect(applyRecovery(services.catalog, report)).rejects.toThrow('Response lost');
		expect((await services.catalog.getCurrentSnapshot()).projects).toHaveLength(1);
	});

	it('recovers a dangling pointer from its previous snapshot without guessing the newest candidate', async () => {
		const { bucket, services } = await fixture();
		const current = await services.catalog.getCurrentSnapshot();
		await services.catalog.mutateSnapshot('later', ACTOR, (snapshot) => snapshot);
		const missing = await services.catalog.getCurrentSnapshot();
		await bucket.delete(paths.snapshot(missing.snapshot_id));
		const source = { mode: 'snapshot', snapshotId: current.snapshot_id } as const;
		const report = await services.catalog.planRecovery(source);
		expect(
			report.candidates.find((candidate) => candidate.id === current.snapshot_id)?.reference,
		).toBe('previous');
		await services.catalog.recover(source, ACTOR, { token: report.token, writersStopped: true });
		expect((await services.catalog.getCurrentSnapshot()).projects).toHaveLength(1);
		expect(await (await bucket.get(paths.catalog))!.json()).toMatchObject({
			previous_snapshot_id: current.snapshot_id,
		});
	});

	it('blocks missing snapshots, missing parent metadata, and mismatched IDs', async () => {
		const { bucket, services, project, notebook } = await fixture();
		expect(
			(await services.catalog.planRecovery({ mode: 'snapshot', snapshotId: createSnapshotId() }))
				.issues,
		).toContainEqual(
			expect.objectContaining({
				severity: 'error',
				message: 'Selected snapshot is missing or invalid.',
			}),
		);
		await bucket.put(
			paths.project(project.id).notebook(notebook.id).meta,
			JSON.stringify(makeNotebookMeta({ project_id: project.id })),
		);
		expect((await services.catalog.planRecovery(SOURCE)).issues).toContainEqual(
			expect.objectContaining({
				severity: 'error',
				message: 'Notebook IDs do not match its storage path.',
			}),
		);
		await bucket.delete(paths.project(project.id).meta);
		expect((await services.catalog.planRecovery(SOURCE)).issues).toContainEqual(
			expect.objectContaining({ key: paths.project(project.id).meta, severity: 'error' }),
		);
	});

	it.each(['rebuild', 'snapshot'] as const)(
		'reports an empty notebook author and blocks %s recovery',
		async (mode) => {
			const { bucket, services, project, notebook } = await fixture();
			const healthy = await services.notebooks.createNotebook(project.id, INPUT, ACTOR);
			const selected = await services.catalog.getCurrentSnapshot();
			const key = paths.project(project.id).notebook(notebook.id).meta;
			await bucket.put(
				key,
				JSON.stringify(makeNotebookMeta({ id: notebook.id, project_id: project.id, author: '' })),
			);
			const put = vi.spyOn(bucket, 'put');
			const remove = vi.spyOn(bucket, 'delete');
			const report = await services.catalog.planRecovery(
				mode === 'rebuild' ? SOURCE : { mode, snapshotId: selected.snapshot_id },
			);
			expect(report.issues).toContainEqual({
				key,
				severity: 'error',
				message: 'Notebook author is invalid.',
			});
			expect(report.projects[0].notebooks.map((entry) => entry.id)).toEqual([healthy.id]);
			await expect(applyRecovery(services.catalog, report)).rejects.toThrow('blocked');
			expect(put).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
		},
	);

	it('paginates inventory instead of losing projects past the first page', async () => {
		const { bucket, services } = await fixture();
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementation((options) => list({ ...options, limit: 1 }));
		await services.projects.createProject({ name: 'Second', description: '' }, ACTOR);
		await eraseIndex(bucket);
		expect((await services.catalog.planRecovery(SOURCE)).projects).toHaveLength(2);
	});
	it('rejects changes during inspection and propagates storage outages', async () => {
		const { bucket, services, project } = await fixture();
		const get = bucket.get.bind(bucket);
		let changed = false;
		const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (!changed && key === paths.project(project.id).meta) {
				changed = true;
				await bucket.put(key, JSON.stringify({ ...project, name: 'Concurrent' }));
			}
			return get(key);
		});
		await expect(services.catalog.planRecovery(SOURCE)).rejects.toThrow('Storage changed');
		spy.mockRejectedValue(new Error('Storage unavailable'));
		await expect(services.catalog.planRecovery(SOURCE)).rejects.toThrow('Storage unavailable');
	});

	it('reports missing code and job definitions referenced by a selected snapshot', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const job = await services.jobs.createJob(project.id, notebook.id, { name: 'Missing' }, ACTOR);
		const current = await services.catalog.getCurrentSnapshot();
		const nb = paths.project(project.id).notebook(notebook.id);
		await bucket.delete([nb.workspaceFile('notebook.py'), nb.job(job.id).head]);
		const report = await services.catalog.planRecovery({
			mode: 'snapshot',
			snapshotId: current.snapshot_id,
		});
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: nb.workspaceFile('notebook.py'), severity: 'error' }),
				expect.objectContaining({ key: nb.job(job.id).head, severity: 'error' }),
			]),
		);
	});

	it('preserves unknown snapshot fields and the schema version during snapshot recovery', async () => {
		const { bucket, services } = await fixture();
		const current = await services.catalog.getCurrentSnapshot();
		await bucket.put(
			paths.snapshot(current.snapshot_id),
			JSON.stringify({ ...current, schema_version: 2, future_field: { retained: true } }),
		);
		const source = { mode: 'snapshot', snapshotId: current.snapshot_id } as const;
		const report = await services.catalog.planRecovery(source);
		await services.catalog.recover(source, ACTOR, { token: report.token, writersStopped: true });
		expect(await services.catalog.getCurrentSnapshot()).toMatchObject({
			schema_version: 2,
			future_field: { retained: true },
		});
	});

	it('replaces a corrupt catalog conditionally and never writes metadata records', async () => {
		const { bucket, services } = await fixture();
		await bucket.put(paths.catalog, 'broken');
		const report = await services.catalog.planRecovery(SOURCE);
		const put = vi.spyOn(bucket, 'put');
		await applyRecovery(services.catalog, report);
		expect(
			put.mock.calls.some(
				([key, , options]) =>
					key === paths.catalog && options?.onlyIfEtagMatches === report.catalogEtag,
			),
		).toBe(true);
		expect(put.mock.calls.every(([key]) => key.startsWith('_system/'))).toBe(true);
		expect((await services.catalog.getCurrentSnapshot()).projects).toHaveLength(1);
	});
	it('blocks recovery when storage cannot provide ETags', async () => {
		const { bucket, services, project } = await fixture();
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementation(async (options) => {
			const result = await list(options);
			return { ...result, objects: result.objects.map((object) => ({ ...object, etag: '' })) };
		});
		const report = await services.catalog.planRecovery(SOURCE);
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				key: paths.project(project.id).meta,
				severity: 'error',
				message: 'Storage must provide non-empty ETags for recovery.',
			}),
		);
		const put = vi.spyOn(bucket, 'put');
		const remove = vi.spyOn(bucket, 'delete');
		await expect(applyRecovery(services.catalog, report)).rejects.toThrow('blocked');
		expect(put).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it.each(['invalid JSON', 'wrong schema', 'mismatched ID'])(
		'reports a snapshot with %s without selecting it or replacing the catalog',
		async (corruption) => {
			const { bucket, services } = await fixture();
			const id = createSnapshotId();
			const key = paths.snapshot(id);
			const body =
				corruption === 'invalid JSON'
					? '{'
					: JSON.stringify(corruption === 'wrong schema' ? {} : makeSnapshot());
			await bucket.put(key, body);
			const originalCatalog = await (await bucket.get(paths.catalog))!.text();
			const put = vi.spyOn(bucket, 'put');
			const rebuild = await services.catalog.planRecovery(SOURCE);
			expect(rebuild.issues).toContainEqual(expect.objectContaining({ key, severity: 'warning' }));
			expect(rebuild.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
			expect(rebuild.candidates.map((candidate) => candidate.id)).not.toContain(id);
			const source = { mode: 'snapshot', snapshotId: id } as const;
			const report = await services.catalog.planRecovery(source);
			await expect(applyRecovery(services.catalog, report)).rejects.toThrow('blocked');
			expect(put).not.toHaveBeenCalled();
			expect(await (await bucket.get(paths.catalog))!.text()).toBe(originalCatalog);
		},
	);

	it.each(['preparing', 'publishing', 'complete', 'expired'])(
		'recovers only the completed import attempt when its receipt is %s',
		async (state) => {
			const { bucket, services, project, notebook } = await fixture();
			const previousId = createNotebookId();
			const currentId = createNotebookId();
			for (const id of [previousId, currentId])
				await services.notebooks.stageImportNotebook(project.id, id, INPUT, ACTOR);
			await bucket.put(
				paths.project(project.id).notebookImport(createImportId()).item('entry'),
				JSON.stringify({
					actor: ACTOR,
					input: { entry_notebook: 'notebook.py', title: 'Imported' },
					notebook_id: currentId,
					attempts: [previousId, currentId],
					state,
					lease_until: 0,
				}),
			);
			await eraseIndex(bucket);
			const report = await services.catalog.planRecovery(SOURCE);
			const expected = state === 'complete' ? [notebook.id, currentId] : [notebook.id];
			expect(report.projects[0].notebooks.map((entry) => entry.id).sort()).toEqual(expected.sort());
			expect(report.projects[0].notebook_count).toBe(expected.length);
			expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
			await applyRecovery(services.catalog, report);
			expect(
				(await services.catalog.getCurrentSnapshot()).projects[0].notebooks
					.map((entry) => entry.id)
					.sort(),
			).toEqual(expected.sort());
		},
	);

	it('blocks reconstruction if an import receipt cannot prove which attempt completed', async () => {
		const { bucket, services, project } = await fixture();
		const receipt = paths.project(project.id).notebookImport(createImportId()).item('entry');
		await bucket.put(receipt, JSON.stringify({ state: 'complete' }));
		const report = await services.catalog.planRecovery(SOURCE);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ key: receipt, severity: 'error' }),
		);
		const put = vi.spyOn(bucket, 'put');
		await expect(applyRecovery(services.catalog, report)).rejects.toThrow('blocked');
		expect(put).not.toHaveBeenCalled();
	});

	it.each(['draft', 'active'] as const)(
		'handles an unsynced Git notebook with status %s',
		async (status) => {
			const { bucket, services, project } = await fixture();
			const { meta } = await services.notebooks.synced.create(
				project.id,
				{
					title: 'Synced',
					description: '',
					repo: 'owner/repo',
					branch: 'main',
					root_path: '',
					entry_notebook: 'app.py',
				},
				ACTOR,
			);
			const nb = paths.project(project.id).notebook(meta.id);
			await bucket.put(nb.meta, JSON.stringify({ ...meta, status }));
			const report = await services.catalog.planRecovery(SOURCE);
			const errors = report.issues.filter((issue) => issue.severity === 'error');
			if (status === 'draft') {
				expect(errors).toEqual([]);
				await applyRecovery(services.catalog, report);
				expect((await services.catalog.getCurrentSnapshot()).projects[0].notebooks).toContainEqual(
					expect.objectContaining({ id: meta.id, status: 'draft', source_type: 'git' }),
				);
			} else {
				expect(errors).toContainEqual(
					expect.objectContaining({
						key: nb.source,
						message: 'Published synced notebook has no current version.',
					}),
				);
				const put = vi.spyOn(bucket, 'put');
				await expect(applyRecovery(services.catalog, report)).rejects.toThrow('blocked');
				expect(put).not.toHaveBeenCalled();
			}
		},
	);

	it.each(['snapshot', 'catalog'])(
		'preserves the old pointer when the recovery %s write fails',
		async (phase) => {
			const { bucket, services } = await fixture();
			const original = await services.catalog.getCurrentSnapshot();
			const originalCatalog = await (await bucket.get(paths.catalog))!.text();
			const report = await services.catalog.planRecovery(SOURCE);
			const put = bucket.put.bind(bucket);
			const attempts: string[] = [];
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				attempts.push(key);
				if (phase === 'snapshot' ? key.startsWith(paths.snapshotsPrefix) : key === paths.catalog)
					throw new Error('Storage write unavailable');
				return put(key, value, options);
			});
			const remove = vi.spyOn(bucket, 'delete');
			await expect(applyRecovery(services.catalog, report)).rejects.toThrow(
				'Storage write unavailable',
			);
			expect(await (await bucket.get(paths.catalog))!.text()).toBe(originalCatalog);
			expect((await services.catalog.getCurrentSnapshot()).snapshot_id).toBe(original.snapshot_id);
			expect(attempts.filter((key) => key === paths.catalog)).toHaveLength(
				phase === 'snapshot' ? 0 : 1,
			);
			expect(remove).not.toHaveBeenCalled();
		},
	);

	it('rejects reusing a report after a successful recovery', async () => {
		const { bucket, services } = await fixture();
		const report = await services.catalog.planRecovery(SOURCE);
		const recovered = await applyRecovery(services.catalog, report);
		const put = vi.spyOn(bucket, 'put');
		await expect(applyRecovery(services.catalog, report)).rejects.toThrow('stale');
		expect(put).not.toHaveBeenCalled();
		expect((await services.catalog.getCurrentSnapshot()).snapshot_id).toBe(recovered.snapshot_id);
	});

	it('uses current job settings only for jobs in the selected snapshot', async () => {
		const { services, project, notebook } = await fixture();
		const selectedJob = await services.jobs.createJob(
			project.id,
			notebook.id,
			{ name: 'Selected', schedule: { cron: '0 0 * * *', timezone: 'UTC' } },
			ACTOR,
		);
		const selected = await services.catalog.getCurrentSnapshot();
		await services.jobs.updateJob(
			project.id,
			notebook.id,
			selectedJob.id,
			{ enabled: false, schedule: { cron: '0 12 * * *', timezone: 'UTC' } },
			ACTOR,
		);
		await services.jobs.createJob(project.id, notebook.id, { name: 'Later' }, ACTOR);
		const report = await services.catalog.planRecovery({
			mode: 'snapshot',
			snapshotId: selected.snapshot_id,
		});
		expect(report.projects[0].notebooks[0].jobs).toEqual([
			expect.objectContaining({
				id: selectedJob.id,
				enabled: false,
				schedule: { cron: '0 12 * * *', timezone: 'UTC' },
			}),
		]);
		await services.jobs.updateJob(
			project.id,
			notebook.id,
			selectedJob.id,
			{ schedule: null },
			ACTOR,
		);
		const cleared = await services.catalog.planRecovery(report.source);
		const recovered = await applyRecovery(services.catalog, cleared);
		expect(recovered.projects[0].notebooks[0].jobs).toEqual([
			expect.objectContaining({ id: selectedJob.id, enabled: false }),
		]);
		expect(recovered.projects[0].notebooks[0].jobs![0].schedule).toBeUndefined();
	});

	it('blocks recovery of a job whose history index is missing', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const job = await services.jobs.createJob(
			project.id,
			notebook.id,
			{ name: 'Incomplete' },
			ACTOR,
		);
		await bucket.delete(
			paths.project(project.id).notebook(notebook.id).jobIndex(job.created_at, job.id),
		);
		const report = await services.catalog.planRecovery(SOURCE);
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				severity: 'error',
				message: 'Job history index is missing; repair it before catalog recovery.',
			}),
		);
		const put = vi.spyOn(bucket, 'put');
		await expect(applyRecovery(services.catalog, report)).rejects.toThrow('blocked');
		expect(put).not.toHaveBeenCalled();
	});
	it('reports projects, notebooks, and jobs that a selected snapshot leaves out', async () => {
		const { bucket, services, project, notebook } = await fixture();
		const selected = await services.catalog.getCurrentSnapshot();
		const laterNotebook = await services.notebooks.createNotebook(project.id, INPUT, ACTOR);
		const laterJob = await services.jobs.createJob(
			project.id,
			notebook.id,
			{ name: 'Later' },
			ACTOR,
		);
		const laterProject = await services.projects.createProject(
			{ name: 'Later', description: '' },
			ACTOR,
		);
		await bucket.delete(paths.catalog);
		const report = await services.catalog.planRecovery({
			mode: 'snapshot',
			snapshotId: selected.snapshot_id,
		});
		const projectPaths = paths.project(project.id);
		expect(
			report.issues
				.filter((entry) => entry.message.includes('absent from the selected snapshot'))
				.map(({ key, severity }) => ({ key, severity })),
		).toEqual(
			expect.arrayContaining([
				{ key: paths.project(laterProject.id).meta, severity: 'excluded' },
				{ key: projectPaths.notebook(laterNotebook.id).meta, severity: 'excluded' },
				{ key: projectPaths.notebook(notebook.id).job(laterJob.id).head, severity: 'excluded' },
			]),
		);
		expect(report.projects.map((entry) => entry.id)).toEqual([project.id]);
	});

	it('reads only the selected and pointer snapshots in snapshot mode', async () => {
		const { bucket, services } = await fixture();
		const selected = await services.catalog.getCurrentSnapshot();
		await services.catalog.mutateSnapshot('later', ACTOR, (snapshot) => snapshot);
		await services.catalog.mutateSnapshot('latest', ACTOR, (snapshot) => snapshot);
		const get = vi.spyOn(bucket, 'get');
		const report = await services.catalog.planRecovery({
			mode: 'snapshot',
			snapshotId: selected.snapshot_id,
		});
		const snapshotReads = get.mock.calls
			.map(([key]) => key)
			.filter((key) => key.startsWith(paths.snapshotsPrefix));
		expect(snapshotReads).toHaveLength(3);
		expect(report.candidates.length).toBeGreaterThan(3);
		expect(report.candidates.filter((candidate) => candidate.projects === undefined)).not.toEqual(
			[],
		);
	});

	it('keeps records of projects whose IDs share a long prefix apart', async () => {
		const { bucket, services, project, notebook } = await fixture();
		await services.jobs.createJob(project.id, notebook.id, { name: 'Daily' }, ACTOR);
		const sibling = (id: string) => `${id.slice(0, -1)}${id.endsWith('a') ? 'b' : 'a'}`;
		const otherProject = sibling(project.id);
		const otherNotebook = sibling(notebook.id);
		for (const object of await listAllObjects(bucket, `projects/${project.id}/`)) {
			const body = await (await bucket.get(object.key))!.text();
			const rename = (value: string) =>
				value.replaceAll(project.id, otherProject).replaceAll(notebook.id, otherNotebook);
			await bucket.put(rename(object.key), rename(body));
		}
		await eraseIndex(bucket);
		const report = await services.catalog.planRecovery(SOURCE);
		expect(report.issues.filter((entry) => entry.severity === 'error')).toEqual([]);
		expect(
			report.projects
				.map((entry) => ({
					id: entry.id,
					notebooks: entry.notebooks.map((nb) => ({ id: nb.id, jobs: nb.jobs?.length })),
				}))
				.sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual(
			[
				{ id: project.id, notebooks: [{ id: notebook.id, jobs: 1 }] },
				{ id: otherProject, notebooks: [{ id: otherNotebook, jobs: 1 }] },
			].sort((a, b) => a.id.localeCompare(b.id)),
		);
	});

	it('deletes its uncommitted snapshot when it loses the recovery CAS', async () => {
		const { bucket, services } = await fixture();
		await bucket.delete(paths.catalog);
		const report = await services.catalog.planRecovery(SOURCE);
		const before = (await listAllObjects(bucket, paths.snapshotsPrefix)).map((o) => o.key);
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.catalog) await put(key, '{}');
			return put(key, value, options);
		});
		await expect(applyRecovery(services.catalog, report)).rejects.toThrow('conflict');
		expect((await listAllObjects(bucket, paths.snapshotsPrefix)).map((o) => o.key)).toEqual(before);
	});
	it('warns about snapshot keys that snapshot mode skips because their ID is invalid', async () => {
		const { bucket, services } = await fixture();
		const selected = await services.catalog.getCurrentSnapshot();
		const stray = `${paths.snapshotsPrefix}not-a-snapshot-id.json`;
		await bucket.put(stray, '{}');
		const report = await services.catalog.planRecovery({
			mode: 'snapshot',
			snapshotId: selected.snapshot_id,
		});
		expect(report.issues).toContainEqual({
			key: stray,
			severity: 'warning',
			message: 'Snapshot is invalid and cannot be selected.',
		});
	});

	it('keeps a mutation snapshot when the pointer write fails for a reason other than a lost CAS', async () => {
		const { bucket, services } = await fixture();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			const result = await put(key, value, options);
			if (key === paths.catalog) throw new Error('Response lost');
			return result;
		});
		await expect(services.catalog.mutateSnapshot('lost', ACTOR, (s) => s)).rejects.toThrow(
			'Response lost',
		);
		vi.restoreAllMocks();
		expect((await services.catalog.getCurrentSnapshot()).operation).toBe('lost');
	});

	it('deletes a mutation snapshot when the pointer write loses the CAS', async () => {
		const { bucket } = await fixture();
		const before = (await listAllObjects(bucket, paths.snapshotsPrefix)).map((o) => o.key);
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === paths.catalog) throw new PreconditionFailedError();
			return put(key, value, options);
		});
		const catalog = new CatalogService(bucket, undefined, undefined, {
			retries: 2,
			backoffMs: () => 0,
		});
		await expect(catalog.mutateSnapshot('lost', ACTOR, (s) => s)).rejects.toThrow('conflict');
		expect((await listAllObjects(bucket, paths.snapshotsPrefix)).map((o) => o.key)).toEqual(before);
	});
});
