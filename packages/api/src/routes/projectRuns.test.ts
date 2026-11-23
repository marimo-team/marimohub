import { beforeEach, describe, expect, it } from 'vitest';
import { createServices, paths } from '@marimo-hub/core';
import type { JobDefinition, JobRun, UserId } from '@marimo-hub/core';
import { ACTOR, uid, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const VIEWER = uid('viewer');
type Page = { items: JobRun[]; next_cursor: string | null };
describe('project run history routes', () => {
	let bucket: MemoryBucket;
	let services: ReturnType<typeof createServices>;
	let job: JobDefinition;
	const request = (userId: UserId = ACTOR) =>
		createTestApi({ bucket, userId, deps: { policy: { defaultRole: undefined } } }).request;
	const base = () => `/projects/${job.project_id}/runs`;
	const jobBase = (target = job) =>
		`/projects/${target.project_id}/notebooks/${target.notebook_id}/jobs/${target.id}`;
	const trigger = async (tags?: Record<string, string>, target = job) =>
		expectOk<JobRun>(await request()('POST', `${jobBase(target)}/runs`, { tags }), 201);
	beforeEach(async () => {
		bucket = await createInitializedBucket();
		services = createServices(bucket);
		const p = await services.projects.createProject({ name: 'p', description: '' }, ACTOR);
		await services.projects.addMember(p.id, { user_id: VIEWER }, 'viewer', ACTOR);
		const n = await services.notebooks.createNotebook(
			p.id,
			{ title: 'app', description: '', code: 'v1' },
			ACTOR,
		);
		job = await services.jobs.createJob(p.id, n.id, { name: 'job' }, ACTOR);
	});
	it('returns accepted tags across notebooks and versions, without claiming identity isolation', async () => {
		const first = await trigger({ app: 'calibration', app_version: 'v1' });
		await services.notebooks.updateNotebook(job.project_id, job.notebook_id, { code: 'v2' }, ACTOR);
		const second = await trigger({ app: 'calibration', app_version: 'v2' });
		const n = await services.notebooks.createNotebook(
			job.project_id,
			{ title: 'app', description: '', code: 'other' },
			ACTOR,
		);
		const other = await services.jobs.createJob(job.project_id, n.id, { name: 'job' }, ACTOR);
		const collision = await trigger({ app: 'calibration' }, other);
		await trigger({ app: 'distinct' });
		await trigger();
		const page = await expectOk<Page>(
			await request(VIEWER)('GET', `${base()}?tag_key=app&tag_value=calibration`),
		);
		expect(page.items.map((r) => r.run_id)).toEqual([
			collision.run_id,
			second.run_id,
			first.run_id,
		]);
		expect(first.source_version_id).not.toBe(second.source_version_id);
		expect(first.tags).toEqual({ app: 'calibration', app_version: 'v1' });
		expect((await expectOk<Page>(await request()('GET', base()))).items).toHaveLength(5);
		await expectOk(await request(VIEWER)('GET', `${jobBase()}/runs/${first.run_id}`));
	});
	it('preserves empty-page continuation and binds cursors to the project and exact filter, including Unicode', async () => {
		const first = await trigger({ app: '🚀' });
		await trigger({ app: 'other' });
		const query = `tag_key=app&tag_value=${encodeURIComponent('🚀')}`;
		const page = await expectOk<Page>(await request()('GET', `${base()}?limit=1&${query}`));
		expect(page.items).toEqual([]);
		expect(page.next_cursor).not.toBeNull();
		const cursor = encodeURIComponent(page.next_cursor!);
		const last = await expectOk<Page>(
			await request()('GET', `${base()}?limit=1&${query}&cursor=${cursor}`),
		);
		expect(last.items.map((r) => r.run_id)).toEqual([first.run_id]);
		expect(last.next_cursor).toBeNull();
		for (const suffix of [
			`tag_key=app&tag_value=other&cursor=${cursor}`,
			`cursor=${cursor}`,
			'cursor=bad',
		])
			await expectError(await request()('GET', `${base()}?${suffix}`), 400);
		const p = await services.projects.createProject({ name: 'other', description: '' }, ACTOR);
		await expectError(
			await request()('GET', `/projects/${p.id}/runs?${query}&cursor=${cursor}`),
			400,
		);
	});
	it('rejects incomplete filters and invalid submission tags', async () => {
		for (const query of [
			'tag_key=app',
			'tag_value=x',
			'tag_key=&tag_value=x',
			'tag_key=app&tag_value=x&regex=true',
		])
			await expectError(await request()('GET', `${base()}?${query}`), 422);
		for (const tags of [{ app: 2 }, { app: 'x'.repeat(257) }, { app: { nested: true } }])
			await expectError(await request()('POST', `${jobBase()}/runs`, { tags }), 422);
	});
	it('applies live source authorization independently of colliding tags and revokes membership', async () => {
		const allowed = await trigger({ app: 'shared' });
		const n = await services.notebooks.createNotebook(
			job.project_id,
			{ title: 'restricted', description: '', code: '' },
			ACTOR,
		);
		const restricted = await services.jobs.createJob(job.project_id, n.id, { name: 'job' }, ACTOR);
		await trigger({ app: 'shared' }, restricted);
		const key = paths.project(job.project_id).notebook(n.id).meta;
		const meta = await (await bucket.get(key))!.json<Record<string, unknown>>();
		await bucket.put(
			key,
			JSON.stringify({
				...meta,
				security_labels: { classification: 'SECRET', compartments: ['finance'] },
			}),
		);
		const constrained = createTestApi({
			bucket,
			deps: {
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ compartments: [] }),
				),
			},
		}).request;
		const page = await expectOk<Page>(
			await constrained('GET', `${base()}?tag_key=app&tag_value=shared`),
		);
		expect(page.items.map((r) => r.run_id)).toEqual([allowed.run_id]);
		const p = await services.projects.createProject({ name: 'other', description: '' }, ACTOR);
		const otherNotebook = await services.notebooks.createNotebook(
			p.id,
			{ title: 'other', description: '', code: '' },
			ACTOR,
		);
		const otherJob = await services.jobs.createJob(p.id, otherNotebook.id, { name: 'job' }, ACTOR);
		await trigger({ app: 'shared' }, otherJob);
		expect(
			(await expectOk<Page>(await request()('GET', base()))).items.map((run) => run.run_id),
		).toEqual([allowed.run_id]);
		await services.projects.removeMember(job.project_id, VIEWER, ACTOR);
		await expectError(await request(VIEWER)('GET', base()), 404);
		await bucket.delete(paths.project(job.project_id).notebook(job.notebook_id).meta);
		expect((await expectOk<Page>(await constrained('GET', base()))).items).toEqual([]);
	});
	it('requires editor access for repeatable backfill and does not resurrect deleted jobs', async () => {
		const run = await trigger();
		await bucket.delete(paths.project(job.project_id).runIndex(run.run_id));
		await expectError(await request(VIEWER)('POST', `${jobBase()}/history-backfill`), 403);
		for (let i = 0; i < 2; i++)
			await expectOk(await request()('POST', `${jobBase()}/history-backfill?limit=1`));
		expect(
			(await expectOk<Page>(await request()('GET', base()))).items.map((r) => r.run_id),
		).toEqual([run.run_id]);
		await services.jobRuns.cancel(run, ACTOR);
		await expectOk(await request()('DELETE', jobBase(), undefined, { 'if-match': job.updated_at }));
		await services.jobRuns.publishProjectRun(run);
		expect((await expectOk<Page>(await request()('GET', base()))).items).toEqual([]);
	});
	it('gates the new routes when jobs are disabled', async () => {
		const off = createTestApi({ bucket, deps: { jobs: undefined } }).request;
		await expectError(await off('GET', base()), 404);
		await expectError(await off('POST', `${jobBase()}/history-backfill`), 404);
	});
});
