import { describe, expect, it, vi, afterEach } from 'vitest';
import { toPublicJobRun } from '@marimo-hub/core';
import { createAppJobsFixture } from '../testing/appJobs';
import { expectOk } from '../testing';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const f = await createAppJobsFixture();
	const run = await f.services.jobRuns.enqueue({
		job: f.job,
		trigger: 'manual',
		triggeredBy: f.user,
		timeoutSeconds: 600,
		metadata: { initial: true },
	});
	await f.services.jobRuns.transition(run, 'provision', () => ({
		deadline_at: new Date(Date.now() + 600_000).toISOString(),
	}));
	const token = await f.services.jobRuns.issueExecutionCredential(run);
	await f.services.jobRuns.transition(run, 'start');
	const call = (op: string, body: unknown = {}, credential = token) =>
		f.client.app.request(`http://hub.test/api/job-execution/v1/${op}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	return { ...f, run, token, callRun: call };
}

describe('job execution credentials', () => {
	it('flushes metadata before stop acknowledgement and rejects late writes', async () => {
		const f = await fixture();
		await expectOk(
			await f.call('stop', {
				job_id: f.job.id,
				run_id: f.run.run_id,
				input: { grace_seconds: 30 },
			}),
		);
		expect(await expectOk(await f.callRun('get_run'))).toMatchObject({
			status: 'running',
			stop_request: { requested_by: f.user },
		});
		await expectOk(
			await f.callRun('patch_metadata', {
				report: 'https://app.test/result',
				saved: true,
				initial: null,
			}),
		);
		expect(await expectOk(await f.callRun('acknowledge_stop'))).toMatchObject({
			status: 'cancelled',
			metadata: { report: 'https://app.test/result', saved: true },
		});
		expect((await f.callRun('patch_metadata', { saved: false })).status).toBe(409);
		expect((await f.callRun('acknowledge_stop')).status).toBe(200);
	});

	it('rejects visitor tokens, forged tokens, expired tokens and unknown operations', async () => {
		const f = await fixture();
		expect((await f.callRun('get_run', {}, f.credential)).status).toBe(403);
		expect((await f.callRun('get_run', {}, `${f.token}a`)).status).toBe(403);
		expect((await f.callRun('trigger')).status).toBe(404);
		expect((await f.callRun('acknowledge_stop')).status).toBe(409);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
		expect((await f.callRun('patch_metadata', { result: 1 })).status).toBe(403);
	});

	it('rejects credentials retargeted to another run, attempt, or project', async () => {
		const f = await fixture();
		const other = await f.services.jobRuns.enqueue({
			job: f.job,
			trigger: 'manual',
			timeoutSeconds: 600,
		});
		const prefix = 'mhub_run_';
		const claims = JSON.parse(
			Buffer.from(f.token.slice(prefix.length), 'base64url').toString(),
		) as Record<string, unknown>;
		for (const patch of [
			{ run_id: other.run_id },
			{ attempt: f.run.attempt + 1 },
			{ project_id: 'not-a-project' },
		]) {
			const token = `${prefix}${Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url')}`;
			expect((await f.callRun('patch_metadata', { saved: true }, token)).status).toBe(403);
		}
		expect(
			(await f.services.jobRuns.getRun(f.project.id, f.notebook.id, f.job.id, other.run_id))
				.metadata,
		).toBeUndefined();
	});

	it('rejects malformed and oversized patch bodies without changing metadata', async () => {
		const f = await fixture();
		for (const patch of [null, [], { nested: {} }, { value: 'x'.repeat(2049) }]) {
			expect((await f.callRun('patch_metadata', patch)).status).toBe(400);
		}
		expect((await f.callRun('patch_metadata', { value: 'x'.repeat(20_000) })).status).toBe(413);
		expect(await expectOk(await f.callRun('get_run'))).toMatchObject({
			metadata: { initial: true },
		});
	});

	it('has no run selector or authority to mutate tags, parameters or status', async () => {
		const f = await fixture();
		expect((await f.callRun('patch_metadata', { tags: { app: 'forged' } })).status).toBe(400);
		await expectOk(
			await f.callRun('patch_metadata', { status: 'succeeded', run_id: 'another-run' }),
		);
		const run = await f.services.jobRuns.getRun(
			f.project.id,
			f.notebook.id,
			f.job.id,
			f.run.run_id,
		);
		expect(run.status).toBe('running');
		expect(run.run_id).toBe(f.run.run_id);
		expect(toPublicJobRun(run)).not.toHaveProperty('execution_credential_hash');
		expect(toPublicJobRun(run)).not.toHaveProperty('initial_metadata');
	});
});
