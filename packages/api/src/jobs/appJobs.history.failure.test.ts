import { afterEach, describe, expect, it, vi } from 'vitest';
import { signAppJobCredential, UnavailableError } from '@marimo-hub/core';
import type { PublicJobRun } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { expectOk } from '../testing';
import type { Page } from '../pagination';
import { createAppJobsFixture } from '../testing/appJobs';

type RunPage = Page<PublicJobRun>;

afterEach(() => vi.restoreAllMocks());

describe('app history failure boundaries', () => {
	it('rejects invalid filters and bodies before scanning history', async () => {
		const f = await createAppJobsFixture();
		const scan = vi.spyOn(f.client.deps.services.jobRuns, 'listProjectRunsPage');
		for (const body of [
			'{',
			'null',
			'[]',
			{ limit: 0 },
			{ limit: -1 },
			{ limit: 1.5 },
			{ limit: 'NaN' },
			{ limit: '1' },
			{ limit: true },
			{ status: 'unknown' },
			{ triggered_by: '' },
			{ triggered_by_me: 'true' },
			{ triggered_by_me: 'false' },
			{ tag_value: 'unpaired' },
			{ tag_key: '', tag_value: 'value' },
			{ cursor: 42 },
			{ cursor: btoa(JSON.stringify({})) },
			{ job_id: f.job.id },
			{ parameters: { private: 'input' } },
		]) {
			const response = await f.call('list_project_runs', body);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		expect(scan).not.toHaveBeenCalled();
		expect((await f.call('list_project_runs', 'x'.repeat(65537))).status).toBe(413);
		expect(scan).not.toHaveBeenCalled();
	});

	it('requires valid visitor credentials even for an empty project history', async () => {
		const f = await createAppJobsFixture();
		const scan = vi.spyOn(f.client.deps.services.jobRuns, 'listProjectRunsPage');
		const expired = await signAppJobCredential(f.claims, f.secret, Date.now() - 300001);
		const wrongEndpoint = await signAppJobCredential(
			{ ...f.claims, endpoint: 'https://other.test/api/app-jobs/v1' },
			f.secret,
		);
		for (const token of [null, 'forged', expired, wrongEndpoint]) {
			expect((await f.call('list_project_runs', {}, token)).status).toBe(401);
		}
		expect(scan).not.toHaveBeenCalled();
	});

	it.each([true, new UnavailableError('identity unavailable')])(
		'fails closed when visitor identity cannot authorize history (%#)',
		async (result) => {
			const f = await createAppJobsFixture();
			const scan = vi.spyOn(f.client.deps.services.jobRuns, 'listProjectRunsPage');
			vi.spyOn(f.client.deps.services.identities, 'isSuspended').mockImplementation(async () => {
				if (result instanceof Error) throw result;
				return result;
			});
			expect((await f.call('list_project_runs', {})).status).toBe(result === true ? 403 : 503);
			expect(scan).not.toHaveBeenCalled();
		},
	);

	it('bounds a request and does not rescan to fill a filtered empty page', async () => {
		const f = await createAppJobsFixture();
		await expectOk(await f.call('trigger'));
		await expectOk(await f.call('trigger'));
		const scan = vi.spyOn(f.client.deps.services.jobRuns, 'listProjectRunsPage');
		const first = await expectOk<RunPage>(
			await f.call('list_project_runs', { status: 'succeeded', limit: 1 }),
		);
		expect(first.items).toEqual([]);
		expect(first.next_cursor).not.toBeNull();
		expect(scan).toHaveBeenCalledTimes(1);
		const last = await expectOk<RunPage>(
			await f.call('list_project_runs', {
				status: 'succeeded',
				limit: 1,
				cursor: first.next_cursor,
			}),
		);
		expect(last).toEqual({ items: [], next_cursor: null });
		expect(scan).toHaveBeenCalledTimes(2);
		await expectOk(await f.call('list_project_runs', { limit: 1000000 }));
		expect(scan).toHaveBeenLastCalledWith(f.project.id, 500, undefined, undefined);
	});

	it('returns an error rather than a partial success when source authorization fails', async () => {
		const f = await createAppJobsFixture();
		const other = await f.services.jobs.createJob(
			f.project.id,
			f.notebook.id,
			{ name: 'other', consumer_execution: true },
			ACTOR,
		);
		await expectOk(await f.call('trigger'));
		await expectOk(await f.call('trigger', { job_id: other.id }));
		const jobs = f.client.deps.services.jobs;
		const getJob = jobs.getJob.bind(jobs);
		vi.spyOn(jobs, 'getJob').mockImplementation(async (pid, nid, jid) => {
			if (jid === other.id) throw new UnavailableError('job store unavailable');
			return getJob(pid, nid, jid);
		});
		const response = await f.call('list_project_runs', {});
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toMatchObject({ success: false });
		expect(body).not.toHaveProperty('data');
	});

	it('rechecks sharing and run status between pages without losing continuation', async () => {
		const f = await createAppJobsFixture();
		const bob = await f.visitAs(uid('history-bob'));
		const setSharing = (consumer_history: 'shared' | 'private') =>
			f.services.jobs.updateJob(f.project.id, f.notebook.id, f.job.id, { consumer_history }, ACTOR);
		await setSharing('shared');
		const older = await expectOk<PublicJobRun>(await bob.call('trigger'));
		await expectOk(await bob.call('trigger'));
		await expectOk(await bob.call('trigger'));
		const filter = { status: 'active', triggered_by: bob.user, limit: 1 };
		const first = await expectOk<RunPage>(await f.call('list_project_runs', filter));
		expect(first.items).toHaveLength(1);
		await setSharing('private');
		const second = await expectOk<RunPage>(
			await f.call('list_project_runs', { ...filter, cursor: first.next_cursor }),
		);
		expect(second.items).toEqual([]);
		expect(second.next_cursor).not.toBeNull();
		await setSharing('shared');
		const run = await f.services.jobRuns.getRun(
			f.project.id,
			f.notebook.id,
			f.job.id,
			older.run_id,
		);
		await f.services.jobRuns.transition(run, 'fail');
		const last = await expectOk<RunPage>(
			await f.call('list_project_runs', { ...filter, cursor: second.next_cursor }),
		);
		expect(last).toEqual({ items: [], next_cursor: null });
	});
});
