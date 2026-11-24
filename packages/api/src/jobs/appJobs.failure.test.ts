import { afterEach, describe, expect, it, vi } from 'vitest';
import { signAppJobCredential, verifyAppJobCredential, UnavailableError } from '@marimo-hub/core';
import { MAX_ACTIVE_CONSUMER_RUNS_PER_JOB } from '@marimo-hub/core/jobs';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { expectOk } from '../testing';
import {
	createAppJobsFixture as fixture,
	APP_JOBS_TEST_ENDPOINT as endpoint,
} from '../testing/appJobs';

afterEach(() => vi.restoreAllMocks());

describe('app job failure boundaries', () => {
	it.each([
		null,
		'',
		'mhub_app_',
		'mhub_app_!.!',
		'mhub_app_a.b.c',
		`mhub_app_${'x'.repeat(17000)}`,
	])('rejects missing or malformed credentials (%#)', async (token) => {
		const f = await fixture();
		expect((await f.call('trigger', undefined, token)).status).toBe(401);
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it.each(['{', 'null', '[]', '{}', '{"job_id":42}', '{"job_id":"invalid"}'])(
		'rejects malformed bodies (%s)',
		async (body) => {
			const f = await fixture();
			expect((await f.call('trigger', body)).status).toBe(400);
			expect(await f.services.jobRuns.listActive()).toEqual([]);
		},
	);

	it('rejects unknown operations, missing run IDs, invalid parameters, and oversized bodies without creating runs', async () => {
		const f = await fixture();
		expect((await f.call('cancel')).status).toBe(404);
		expect((await f.call('get_run')).status).toBe(400);
		expect((await f.call('trigger', { job_id: f.job.id, input: { parameters: [] } })).status).toBe(
			400,
		);
		expect((await f.call('trigger', 'x'.repeat(65537))).status).toBe(413);
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it('rejects expired access, allows bounded refresh, and never extends the refresh deadline', async () => {
		const f = await fixture();
		const expired = await signAppJobCredential(f.claims, f.secret, Date.now() - 300001);
		expect((await f.call('trigger', undefined, expired)).status).toBe(401);
		const renewed = await expectOk<{ credential: string }>(await f.call('refresh', {}, expired));
		expect(
			(await verifyAppJobCredential(renewed.credential, f.secret, endpoint))?.refreshUntil,
		).toBe(f.claims.refreshUntil);
		const ended = await signAppJobCredential(
			{ ...f.claims, refreshUntil: Date.now() - 1 },
			f.secret,
		);
		expect((await f.call('refresh', {}, ended)).status).toBe(401);
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it('rejects wrong audiences and modified routing proofs', async () => {
		const f = await fixture();
		for (const claims of [
			{ ...f.claims, endpoint: 'https://other.test/api/app-jobs/v1' },
			{ ...f.claims, routingToken: `${f.claims.routingToken}x` },
		]) {
			const token = await signAppJobCredential(claims, f.secret);
			expect((await f.call('trigger', undefined, token)).status).toBe(401);
		}
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it('caps each visitor in-flight runs per job without limiting other visitors or editors', async () => {
		const f = await fixture();
		for (let i = 0; i < MAX_ACTIVE_CONSUMER_RUNS_PER_JOB; i++)
			await expectOk(await f.call('trigger'));
		const capped = await f.call('trigger');
		expect(capped.status).toBe(429);
		expect(await capped.json()).toMatchObject({
			success: false,
			error: { code: 'RESOURCE_EXHAUSTED' },
		});
		await expectOk(await (await f.visitAs(uid('second-visitor'))).call('trigger'));
		const editor = await f.visitAs(ACTOR);
		for (let i = 0; i <= MAX_ACTIVE_CONSUMER_RUNS_PER_JOB; i++)
			await expectOk(await editor.call('trigger'));
		expect(await f.services.jobRuns.listActive()).toHaveLength(
			2 * MAX_ACTIVE_CONSUMER_RUNS_PER_JOB + 2,
		);
	});

	it('cannot target jobs in another project even when the user can read both projects', async () => {
		const f = await fixture();
		const project = await f.services.projects.createProject(
			{ name: 'other', description: '' },
			ACTOR,
		);
		await f.services.projects.addMember(project.id, { user_id: f.user }, 'app-user', ACTOR);
		const notebook = await f.services.notebooks.createNotebook(
			project.id,
			{ title: 'other', description: '', code: '' },
			ACTOR,
		);
		const job = await f.services.jobs.createJob(
			project.id,
			notebook.id,
			{ name: 'other', consumer_execution: true },
			ACTOR,
		);
		expect((await f.call('trigger', { job_id: job.id })).status).toBe(404);
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it('rechecks membership for both operations and refresh', async () => {
		const f = await fixture();
		await f.services.projects.removeMember(f.project.id, f.user, ACTOR);
		for (const operation of ['trigger', 'list_active_runs', 'refresh'])
			expect((await f.call(operation)).status).toBe(403);
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it('rechecks execution policy, and submission tags cannot grant access', async () => {
		const f = await fixture();
		await f.services.jobs.updateJob(
			f.project.id,
			f.notebook.id,
			f.job.id,
			{ consumer_execution: false },
			ACTOR,
		);
		expect(
			(
				await f.call('trigger', {
					job_id: f.job.id,
					input: { tags: { role: 'admin', user_id: ACTOR } },
				})
			).status,
		).toBe(403);
		expect(await f.services.jobRuns.listActive()).toEqual([]);
	});

	it.each([true, new UnavailableError('identity store unavailable')])(
		'fails closed for suspension or unavailable identity checks (%#)',
		async (result) => {
			const f = await fixture();
			vi.spyOn(f.client.deps.services.identities, 'isSuspended').mockImplementation(async () => {
				if (result instanceof Error) throw result;
				return result;
			});
			expect((await f.call('trigger')).status).toBe(result === true ? 403 : 503);
			expect(await f.services.jobRuns.listActive()).toEqual([]);
		},
	);
});
