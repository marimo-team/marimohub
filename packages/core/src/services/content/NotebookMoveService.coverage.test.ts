import { describe, expect, it } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createNotebookId, createProjectId } from '../../ids';
import { paths } from '../../paths';
import { buildBucketSpec } from '../../specs/bucketSpec';
import { createServices } from '../index';

/**
 * Every bucket record under a notebook's base, keyed by its template relative to that base,
 * and the move step that carries it. Only `NotebookService.copyForMove` copies without an
 * owner, so a new notebook-scoped record must be classified here before a move may copy it.
 */
const TRANSFERRED: Record<string, string> = {
	'meta.json': 'NotebookService.copyForMove',
	'preview-runtime.json': 'NotebookService.copyForMove',
	'source.json': 'NotebookService.copyForMove',
	'versions/{vid}/version.json': 'NotebookService.copyForMove',
	'versions/{vid}/git/{relative_path}': 'NotebookService.copyForMove',
	'thumbnail.json': 'ThumbnailService.copyForMove',
	'thumbnails/{image_id}.png': 'ThumbnailService.copyForMove',
	'uploads/{upload_id}.json': 'ResumableUploads.copyForMove',
	'uploads/{upload_id}/parts/{part}': 'ResumableUploads.copyForMove',
	'jobs/{job_id}/job.json': 'JobsService.copyForMove',
	'job-index/{created_at}_{job_id}.json': 'JobsService.copyForMove',
	'jobs/{job_id}/occurrences/{occurrence_key}.json': 'JobRunService.copyForMove',
	'jobs/{job_id}/runs/{run_id}/run.json': 'JobRunService.copyForMove',
	'jobs/{job_id}/runs/{run_id}/output.html': 'JobRunService.copyForMove',
	'jobs/{job_id}/runs/{run_id}/logs.txt': 'JobRunService.copyForMove',
	'jobs/{job_id}/run-index/{reverse_ulid}.json': 'JobRunService.copyForMove',
	'proposals/{proposal_id}/proposal.json': 'NotebookProposalService.copyForMove',
	'proposals/{proposal_id}/publication.json': 'NotebookProposalService.copyForMove',
	'deep-links/{slug}.json': 'DeepLinkService.moveNotebook',
};

/** Records that stay behind: operational state that does not survive a change of project. */
const DROPPED = new Set([
	'fs_snapshot.json',
	'integration_sync_token.json',
	'workspace_mutation_claim.json',
	'thumbnail-attempts/{sandbox_id}.json',
	'uploads/index.json',
]);

const NOTEBOOK_BASE = '/projects/{pid}/notebooks/{nid}/';

function notebookTemplates(): string[] {
	const spec = buildBucketSpec() as { paths: Record<string, unknown> };
	return Object.keys(spec.paths)
		.filter((key) => key.startsWith(NOTEBOOK_BASE))
		.map((key) => key.slice(NOTEBOOK_BASE.length));
}

const concrete = (template: string) => template.replaceAll(/\{([a-z_]+)\}/g, '$1');

describe('notebook move coverage', () => {
	it('classifies every notebook-scoped bucket record as transferred or dropped', () => {
		const templates = notebookTemplates();
		expect(templates.filter((key) => !(key in TRANSFERRED) && !DROPPED.has(key))).toEqual([]);
		expect(
			[...Object.keys(TRANSFERRED), ...DROPPED].filter((key) => !templates.includes(key)),
		).toEqual([]);
	});

	it('copies only the records NotebookService owns in its generic notebook copy', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		const source = createProjectId();
		const destination = createProjectId();
		const nid = createNotebookId();
		const from = paths.project(source).notebook(nid).base;
		const to = paths.project(destination).notebook(nid).base;
		const templates = notebookTemplates();
		for (const template of templates)
			await bucket.put(`${from}/${concrete(template)}`, template.endsWith('.json') ? '{}' : 'x');
		await services.notebooks.copyForMove(source, destination, nid, new Date().toISOString(), 'm');
		const copied = (await bucket.list({ prefix: `${to}/` })).objects.map((object) =>
			object.key.slice(to.length + 1),
		);
		expect(copied.sort()).toEqual(
			templates
				.filter((key) => TRANSFERRED[key] === 'NotebookService.copyForMove')
				.map(concrete)
				.sort(),
		);
	});
});
