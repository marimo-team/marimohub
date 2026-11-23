import { describe, expect, it } from 'vitest';
import type { PublicJobRun } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { expectOk } from '../testing';
import type { Page } from '../pagination';
import { createAppJobsFixture } from '../testing/appJobs';

type RunPage = Page<PublicJobRun>;
const tags = { app: 'immutable-demo' };
const query = { tag_key: 'app', tag_value: tags.app };

describe('app project history', () => {
	it('projects shared cross-notebook history and rechecks live sharing and source access', async () => {
		const f = await createAppJobsFixture();
		const bob = await f.visitAs(uid('bob'));
		const source = await f.services.notebooks.createNotebook(
			f.project.id,
			{ title: 'other version', description: '', code: 'v1' },
			ACTOR,
		);
		const shared = await f.services.jobs.createJob(
			f.project.id,
			source.id,
			{ name: 'shared', consumer_history: 'shared' },
			ACTOR,
		);
		const enqueue = async (job = shared) =>
			f.services.jobRuns.enqueue({
				job,
				trigger: 'manual',
				triggeredBy: bob.user,
				tags,
				parameters: { secret: 'input' },
				timeoutSeconds: 60,
				sourceVersionId: (await f.services.notebooks.getNotebookSource(f.project.id, source.id))
					.current_version_id!,
			});
		const older = await enqueue();
		await f.services.jobRuns.transition(older, 'fail');
		await f.services.notebooks.updateNotebook(f.project.id, source.id, { code: 'v2' }, ACTOR);
		const newer = await enqueue();
		expect(newer.source_version_id).not.toBe(older.source_version_id);
		const privateRun = await enqueue(f.job);
		const history = () => f.call('list_history', query).then(expectOk<RunPage>);
		const page = await history();
		expect(page.items.map((r) => r.run_id)).toEqual([newer.run_id, older.run_id]);
		expect(page.items[0]).not.toHaveProperty('parameters');
		expect(page.items[0]).not.toHaveProperty('error');
		expect(page.items[1].parameters).toEqual({ secret: 'input' });
		expect(page.items.some((r) => r.run_id === privateRun.run_id)).toBe(false);
		expect((await f.call('trigger', { job_id: shared.id })).status).toBe(404);
		expect((await f.call('get_run', { job_id: shared.id, run_id: older.run_id })).status).toBe(404);
		await f.services.jobs.updateJob(
			f.project.id,
			source.id,
			shared.id,
			{ consumer_history: 'private' },
			ACTOR,
		);
		expect((await history()).items).toEqual([]);
		await f.services.jobs.updateJob(
			f.project.id,
			source.id,
			shared.id,
			{ consumer_history: 'shared' },
			ACTOR,
		);
		await f.services.notebooks.setSecurityLabels(
			f.project.id,
			source.id,
			{ classification: 'SECRET', compartments: ['finance'] },
			ACTOR,
		);
		expect((await history()).items).toEqual([]);
	});

	it('keeps colliding tags and foreign cursors inside the admitted project', async () => {
		const f = await createAppJobsFixture();
		const other = await createAppJobsFixture();
		for (let i = 0; i < 2; i++) {
			await expectOk(await other.call('trigger', { job_id: other.job.id, input: { tags } }));
		}
		const foreign = await expectOk<RunPage>(
			await other.call('list_history', { ...query, limit: 1 }),
		);
		expect(foreign.next_cursor).not.toBeNull();
		expect((await expectOk<RunPage>(await f.call('list_history', query))).items).toEqual([]);
		expect((await f.call('list_history', { ...query, cursor: foreign.next_cursor })).status).toBe(
			400,
		);
		// A cursor is a position, not a grant: even a forged local scope cannot select another project.
		const [scope, position] = JSON.parse(atob(foreign.next_cursor!)) as [string, string];
		const forged = btoa(JSON.stringify([scope.replace(other.project.id, f.project.id), position]));
		expect(
			(await expectOk<RunPage>(await f.call('list_history', { ...query, cursor: forged }))).items,
		).toEqual([]);
		await f.services.projects.removeMember(f.project.id, f.user, ACTOR);
		expect((await f.call('list_history', query)).status).not.toBe(200);
	});

	it('preserves empty-page continuation and rejects scope injection and reused filter cursors', async () => {
		const f = await createAppJobsFixture();
		const bob = await f.visitAs(uid('bob'));
		const own = await expectOk<PublicJobRun>(
			await f.call('trigger', { job_id: f.job.id, input: { tags } }),
		);
		await expectOk(await bob.call('trigger', { job_id: f.job.id, input: { tags } }));
		const filter = { ...query, status: 'active', triggered_by_me: 'true', limit: 1 };
		const first = await expectOk<RunPage>(await f.call('list_history', filter));
		expect(first.items).toEqual([]);
		expect(first.next_cursor).not.toBeNull();
		const next = await expectOk<RunPage>(
			await f.call('list_history', { ...filter, cursor: first.next_cursor }),
		);
		expect(next.items.map((r) => r.run_id)).toEqual([own.run_id]);
		expect(next.next_cursor).toBeNull();
		for (const body of [
			{ ...filter, cursor: 'forged' },
			{ ...filter, cursor: first.next_cursor, tag_value: 'other' },
			{ ...filter, cursor: first.next_cursor, status: 'failed' },
			{ ...query, notebook_id: f.notebook.id },
			{ ...query, project_id: f.project.id },
			{ tag_key: 'app' },
			{ triggered_by: bob.user, triggered_by_me: 'true' },
		])
			expect((await f.call('list_history', body)).status).toBe(400);
		expect((await bob.call('list_history', { ...filter, cursor: first.next_cursor })).status).toBe(
			400,
		);
		await expectOk(await f.leave());
		expect((await f.call('list_history', query)).status).toBe(403);
	});
});
