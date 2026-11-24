import { describe, expect, it } from 'vitest';
import type { PublicJobRun } from '@marimo-hub/core';
import { uid, ACTOR } from '@marimo-hub/core/testing';
import { expectOk } from '../testing';
import { createAppJobsFixture } from '../testing/appJobs';

describe('app jobs', () => {
	it('allows the triggerer to stop but rejects other consumers and revoked visits', async () => {
		const f = await createAppJobsFixture();
		const other = await f.visitAs(uid('other-consumer'));
		const run = await expectOk<PublicJobRun>(
			await f.call('trigger', { job_id: f.job.id, input: { metadata: { report: 'initial' } } }),
		);
		expect(run.metadata).toEqual({ report: 'initial' });
		expect((await other.call('stop', { job_id: f.job.id, run_id: run.run_id })).status).toBe(403);
		const stopped = await expectOk<PublicJobRun>(
			await f.call('stop', { job_id: f.job.id, run_id: run.run_id, input: { grace_seconds: 10 } }),
		);
		expect(stopped.status).toBe('cancelled');
		expect(stopped.stop_request).toBeUndefined();
		await expectOk(await f.leave());
		expect((await f.call('stop', { job_id: f.job.id, run_id: run.run_id })).status).toBe(403);
	});

	it('isolates pooled visitors and recovers accepted runs after a visit ends', async () => {
		const f = await createAppJobsFixture(ACTOR);
		const second = await f.visitAs(uid('another-visitor'));
		expect(second.visit.session_id).toBe(f.visit.session_id);
		const [run, secondRun] = await Promise.all([
			f.call('trigger').then((response) => expectOk<PublicJobRun>(response)),
			second.call('trigger').then((response) => expectOk<PublicJobRun>(response)),
		]);
		expect(run.triggered_by).toBe(ACTOR);
		expect(secondRun.triggered_by).toBe(second.user);
		expect((await second.call('get_run', { job_id: f.job.id, run_id: run.run_id })).status).toBe(
			403,
		);
		expect((await f.call('trigger', { job_id: f.job.id, project_id: 'wrong' })).status).toBe(400);
		expect(await expectOk(await f.call('list_active_runs'))).toEqual([run]);
		expect((await f.call('get_run', { job_id: f.job.id, run_id: run.run_id })).status).toBe(200);
		await expectOk(await f.leave());
		expect((await f.call('refresh')).status).toBe(403);
		expect(
			(await f.services.jobRuns.getRun(f.project.id, f.notebook.id, f.job.id, run.run_id)).status,
		).toBe('queued');
		const reconnected = await f.visitAs(ACTOR);
		expect(await expectOk(await reconnected.call('list_active_runs'))).toEqual([run]);
		expect((await f.call('refresh')).status).toBe(403);
	});
});
