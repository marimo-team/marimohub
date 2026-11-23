import { beforeEach, describe, expect, it, vi } from 'vitest';
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
		job = await services.jobs.createJob(
			p.id,
			n.id,
			{ name: 'job', consumer_history: 'shared' },
			ACTOR,
		);
	});
	it.each(['project', 'job'])(
		'reconnects with live user/status filters on %s history',
		async (kind) => {
			const url = () => (kind === 'project' ? base() : `${jobBase()}/runs`);
			const enqueue = (triggeredBy: UserId, tags = { app: 'reconnect' }) =>
				services.jobRuns.enqueue({ job, trigger: 'manual', triggeredBy, tags, timeoutSeconds: 60 });
			const older = await enqueue(VIEWER);
			await services.notebooks.updateNotebook(
				job.project_id,
				job.notebook_id,
				{ code: 'v2' },
				ACTOR,
			);
			const newer = await enqueue(VIEWER);
			const other = await enqueue(ACTOR);
			const tag = kind === 'project' ? '&tag_key=app&tag_value=reconnect' : '';
			const query = `status=active&triggered_by_me=true${tag}`;
			const reader = request(VIEWER);
			const all = await expectOk<Page>(await reader('GET', `${url()}?${query}`));
			expect(all.items.map((r) => r.run_id)).toEqual([newer.run_id, older.run_id]);
			const first = await expectOk<Page>(await reader('GET', `${url()}?${query}&limit=1`));
			expect(first.items).toEqual([]);
			expect(first.next_cursor).not.toBeNull();
			const cursor = encodeURIComponent(first.next_cursor!);
			for (const changed of [
				'status=queued&triggered_by_me=true',
				'status=active',
				'triggered_by_me=true',
				'',
			]) {
				await expectError(await reader('GET', `${url()}?${changed}${tag}&cursor=${cursor}`), 400);
			}
			await expectError(await request()('GET', `${url()}?${query}&cursor=${cursor}`), 400);
			await expectError(await reader('GET', `${url()}?${query}&cursor=bad`), 400);
			await expectError(await reader('GET', `${url()}?status=invalid`), 422);
			await services.jobRuns.transition(newer, 'fail');
			await enqueue(VIEWER);
			const second = await expectOk<Page>(
				await reader('GET', `${url()}?${query}&limit=1&cursor=${cursor}`),
			);
			expect(second.items).toEqual([]);
			expect(second.next_cursor).not.toBeNull();
			const last = await expectOk<Page>(
				await reader(
					'GET',
					`${url()}?${query}&limit=1&cursor=${encodeURIComponent(second.next_cursor!)}`,
				),
			);
			expect(last.items.map((r) => r.run_id)).toEqual([older.run_id]);
			expect(last.next_cursor).toBeNull();
			const explicit = await expectOk<Page>(
				await request()(
					'GET',
					`${url()}?status=queued&triggered_by=${encodeURIComponent(ACTOR)}${tag}`,
				),
			);
			expect(explicit.items.map((r) => r.run_id)).toEqual([other.run_id]);
			await services.projects.removeMember(job.project_id, VIEWER, ACTOR);
			await expectError(await reader('GET', `${url()}?${query}&cursor=${cursor}`), 404);
		},
	);

	it.each(['project', 'job'])(
		'rejects malformed and foreign cursors on %s history',
		async (kind) => {
			await trigger();
			await trigger();
			const url = kind === 'project' ? base() : `${jobBase()}/runs`;
			const query = 'status=active&triggered_by_me=true';
			const page = await expectOk<Page>(await request()('GET', `${url}?${query}&limit=1`));
			const [scope, id] = JSON.parse(atob(page.next_cursor!)) as [string, string];
			for (const value of [
				null,
				{},
				[],
				[scope],
				[scope, id, id],
				[scope, 1],
				[scope, 'bad'],
				[id, id],
			]) {
				const cursor = encodeURIComponent(btoa(JSON.stringify(value)));
				await expectError(await request()('GET', `${url}?${query}&cursor=${cursor}`), 400);
			}
			for (const suffix of ['triggered_by=', 'status=', 'limit=0', 'limit=-1', 'limit=1.5']) {
				await expectError(await request()('GET', `${url}?${suffix}`), 422);
			}
			const other = await services.jobs.createJob(
				job.project_id,
				job.notebook_id,
				{ name: 'other' },
				ACTOR,
			);
			const foreign = kind === 'project' ? `${jobBase()}/runs` : `${jobBase(other)}/runs`;
			await expectError(
				await request()(
					'GET',
					`${foreign}?${query}&cursor=${encodeURIComponent(page.next_cursor!)}`,
				),
				400,
			);
		},
	);

	it.each(['project', 'job'])(
		'matches all active states and excludes terminal runs on %s history',
		async (kind) => {
			const queued = await trigger();
			const provisioning = await trigger();
			await services.jobRuns.transition(provisioning, 'provision');
			const running = await trigger();
			await services.jobRuns.transition(running, 'provision');
			await services.jobRuns.transition(running, 'start');
			for (const event of ['fail', 'timeout', 'cancel'] as const) {
				await services.jobRuns.transition(await trigger(), event);
			}
			const succeeded = await trigger();
			await services.jobRuns.transition(succeeded, 'provision');
			await services.jobRuns.transition(succeeded, 'start');
			await services.jobRuns.transition(succeeded, 'succeed');
			const url = kind === 'project' ? base() : `${jobBase()}/runs`;
			const page = await expectOk<Page>(
				await request()('GET', `${url}?status=active&triggered_by_me=true`),
			);
			expect(page.items.map((r) => r.run_id)).toEqual([
				running.run_id,
				provisioning.run_id,
				queued.run_id,
			]);
			for (const [status, run] of [
				['queued', queued],
				['provisioning', provisioning],
				['running', running],
				['succeeded', succeeded],
			] as const) {
				const exact = await expectOk<Page>(await request()('GET', `${url}?status=${status}`));
				expect(exact.items.map((r) => r.run_id)).toEqual([run.run_id]);
			}
			const absent = await expectOk<Page>(await request()('GET', `${url}?triggered_by=nobody`));
			expect(absent).toEqual({ items: [], next_cursor: null });
		},
	);

	it.each(['project', 'job'])(
		'does not grant private history through explicit user filters on %s history',
		async (kind) => {
			await trigger({ app: 'private' });
			const own = await services.jobRuns.enqueue({
				job,
				trigger: 'manual',
				triggeredBy: VIEWER,
				timeoutSeconds: 60,
				tags: { app: 'private' },
			});
			const url = kind === 'project' ? base() : `${jobBase()}/runs`;
			const tag = kind === 'project' ? '&tag_key=app&tag_value=private' : '';
			const reader = request(VIEWER);
			const first = await expectOk<Page>(await reader('GET', `${url}?status=active&limit=1${tag}`));
			expect(first.items.map((r) => r.run_id)).toEqual([own.run_id]);
			await services.jobs.updateJob(
				job.project_id,
				job.notebook_id,
				job.id,
				{ consumer_history: 'private' },
				ACTOR,
			);
			const next = await expectOk<Page>(
				await reader(
					'GET',
					`${url}?status=active&limit=1${tag}&cursor=${encodeURIComponent(first.next_cursor!)}`,
				),
			);
			expect(next).toEqual({ items: [], next_cursor: null });
			const other = await expectOk<Page>(
				await reader('GET', `${url}?status=active&triggered_by=${encodeURIComponent(ACTOR)}${tag}`),
			);
			expect(other.items).toEqual([]);
			const mine = await expectOk<Page>(
				await reader('GET', `${url}?status=active&triggered_by_me=true${tag}`),
			);
			expect(mine.items.map((r) => r.run_id)).toEqual([own.run_id]);
		},
	);

	it.each(['project', 'job'])(
		'distinguishes literal me from the authenticated user on %s history',
		async (kind) => {
			const own = await trigger();
			const literal = await services.jobRuns.enqueue({
				job,
				trigger: 'manual',
				triggeredBy: uid('me'),
				timeoutSeconds: 60,
			});
			const url = kind === 'project' ? base() : `${jobBase()}/runs`;
			const exact = await expectOk<Page>(await request()('GET', `${url}?triggered_by=me`));
			expect(exact.items.map((r) => r.run_id)).toEqual([literal.run_id]);
			const mine = await expectOk<Page>(
				await request()('GET', `${url}?triggered_by_me=true&limit=1`),
			);
			expect(mine.items).toEqual([]);
			expect(mine.next_cursor).not.toBeNull();
			const cursor = encodeURIComponent(mine.next_cursor!);
			const equivalent = await expectOk<Page>(
				await request()('GET', `${url}?triggered_by=${encodeURIComponent(ACTOR)}&cursor=${cursor}`),
			);
			expect(equivalent.items.map((r) => r.run_id)).toEqual([own.run_id]);
			await expectError(await request()('GET', `${url}?triggered_by=me&cursor=${cursor}`), 400);
			for (const invalid of [
				'triggered_by=me&triggered_by_me=true',
				'triggered_by_me=false',
				'triggered_by_me=1',
			]) {
				await expectError(await request()('GET', `${url}?${invalid}`), 422);
			}
		},
	);

	it.each(['project', 'job'])(
		'continues past corrupt run records on filtered %s history',
		async (kind) => {
			const good = await trigger();
			const corrupt = await trigger();
			await bucket.put(
				paths.project(job.project_id).notebook(job.notebook_id).job(job.id).run(corrupt.run_id)
					.record,
				'{"status":"failed"}',
			);
			const url = kind === 'project' ? base() : `${jobBase()}/runs`;
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const first = await expectOk<Page>(await request()('GET', `${url}?status=queued&limit=1`));
				expect(first.items).toEqual([]);
				expect(first.next_cursor).not.toBeNull();
				const last = await expectOk<Page>(
					await request()(
						'GET',
						`${url}?status=queued&limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`,
					),
				);
				expect(last.items.map((r) => r.run_id)).toEqual([good.run_id]);
				expect(last.next_cursor).toBeNull();
				expect(
					error.mock.calls.some((call) => String(call[0]).includes('stored_object_skipped')),
				).toBe(true);
			} finally {
				error.mockRestore();
			}
		},
	);

	it('combines active and user predicates with immutable tags across versions', async () => {
		const first = await trigger({ app: 'reconnect', version: 'v1' });
		await services.notebooks.updateNotebook(job.project_id, job.notebook_id, { code: 'v2' }, ACTOR);
		const second = await trigger({ app: 'reconnect', version: 'v2' });
		await trigger({ app: 'wrong' });
		await trigger();
		const finished = await trigger({ app: 'reconnect' });
		await services.jobRuns.cancel(finished, ACTOR);
		await services.jobRuns.enqueue({
			job,
			trigger: 'manual',
			triggeredBy: VIEWER,
			timeoutSeconds: 60,
			tags: { app: 'reconnect' },
		});
		const page = await expectOk<Page>(
			await request()(
				'GET',
				`${base()}?tag_key=app&tag_value=reconnect&status=active&triggered_by_me=true`,
			),
		);
		expect(page.items.map((r) => r.run_id)).toEqual([second.run_id, first.run_id]);
		expect(first.source_version_id).not.toBe(second.source_version_id);
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
		const other = await services.jobs.createJob(
			job.project_id,
			n.id,
			{ name: 'job', consumer_history: 'shared' },
			ACTOR,
		);
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

	it.each(['private', 'shared'] as const)(
		'loads each job once per request while applying %s history per run',
		async (history) => {
			job = await services.jobs.updateJob(
				job.project_id,
				job.notebook_id,
				job.id,
				{ consumer_history: history },
				ACTOR,
			);
			const enqueue = (triggeredBy: UserId) =>
				services.jobRuns.enqueue({
					job,
					trigger: 'manual',
					triggeredBy,
					timeoutSeconds: 60,
					parameters: { region: 'eu' },
				});
			const own = await enqueue(VIEWER);
			const active = await enqueue(ACTOR);
			const completed = await enqueue(ACTOR);
			await services.jobRuns.cancel(completed, ACTOR);
			const other = await services.jobs.createJob(
				job.project_id,
				job.notebook_id,
				{ name: 'other' },
				ACTOR,
			);
			await trigger(undefined, other);
			const get = vi.spyOn(bucket, 'get');
			const head = paths.project(job.project_id).notebook(job.notebook_id).job(job.id).head;
			const otherHead = paths.project(job.project_id).notebook(job.notebook_id).job(other.id).head;
			const reader = request(VIEWER);
			const page = await expectOk<Page>(await reader('GET', base()));
			expect(get.mock.calls.filter(([key]) => key === head)).toHaveLength(1);
			expect(get.mock.calls.filter(([key]) => key === otherHead)).toHaveLength(1);
			expect(page.items.find((run) => run.run_id === own.run_id)?.parameters).toEqual({
				region: 'eu',
			});
			expect(page.items.some((run) => run.job_id === other.id)).toBe(false);
			if (history === 'private') {
				expect(page.items.map((run) => run.run_id)).toEqual([own.run_id]);
			} else {
				expect(page.items).toHaveLength(3);
				expect(page.items.find((run) => run.run_id === active.run_id)?.parameters).toBeUndefined();
				expect(page.items.find((run) => run.run_id === completed.run_id)?.parameters).toEqual({
					region: 'eu',
				});
			}
			await services.jobs.updateJob(
				job.project_id,
				job.notebook_id,
				job.id,
				{ consumer_history: history === 'shared' ? 'private' : 'shared' },
				ACTOR,
			);
			get.mockClear();
			const next = await expectOk<Page>(await reader('GET', base()));
			expect(next.items).toHaveLength(history === 'shared' ? 1 : 3);
			expect(get.mock.calls.filter(([key]) => key === head)).toHaveLength(1);
			get.mockRestore();
		},
	);

	it('loads a missing job only once for multiple retained run locators', async () => {
		await trigger();
		await trigger();
		const head = paths.project(job.project_id).notebook(job.notebook_id).job(job.id).head;
		await bucket.delete(head);
		const get = vi.spyOn(bucket, 'get');
		const page = await expectOk<Page>(await request(VIEWER)('GET', base()));
		expect(page.items).toEqual([]);
		expect(get.mock.calls.filter(([key]) => key === head)).toHaveLength(1);
		get.mockRestore();
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
		const restricted = await services.jobs.createJob(
			job.project_id,
			n.id,
			{ name: 'job', consumer_history: 'shared' },
			ACTOR,
		);
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
		const otherJob = await services.jobs.createJob(
			p.id,
			otherNotebook.id,
			{ name: 'job', consumer_history: 'shared' },
			ACTOR,
		);
		await trigger({ app: 'shared' }, otherJob);
		expect(
			(await expectOk<Page>(await request()('GET', base()))).items.map((run) => run.run_id),
		).toEqual([allowed.run_id]);
		await services.projects.removeMember(job.project_id, VIEWER, ACTOR);
		await expectError(await request(VIEWER)('GET', base()), 404);
		await bucket.delete(paths.project(job.project_id).notebook(job.notebook_id).meta);
		expect((await expectOk<Page>(await constrained('GET', base()))).items).toEqual([]);
	});
	it('does not resurrect deleted jobs', async () => {
		const run = await trigger();
		await services.jobRuns.cancel(run, ACTOR);
		await expectOk(await request()('DELETE', jobBase(), undefined, { 'if-match': job.updated_at }));
		await services.jobRuns.publishProjectRun(run);
		expect((await expectOk<Page>(await request()('GET', base()))).items).toEqual([]);
	});
	it.each([false, true])(
		'acknowledges an accepted run when index publication fails afterWrite=%s',
		async (afterWrite) => {
			const put = bucket.put.bind(bucket);
			const fault = vi.spyOn(bucket, 'put').mockImplementation(async (key, ...args) => {
				if (!key.startsWith(paths.project(job.project_id).runIndexPrefix)) return put(key, ...args);
				if (afterWrite) await put(key, ...args);
				throw new Error('index unavailable');
			});
			const send = () =>
				request()(
					'POST',
					`${jobBase()}/runs`,
					{ tags: { app: 'calibration' } },
					{ 'idempotency-key': 'accepted-run' },
				);
			const first = await expectOk<JobRun>(await send(), 201);
			const replay = await expectOk<JobRun>(await send(), 201);
			expect(replay.run_id).toBe(first.run_id);
			expect(await services.jobRuns.listRuns(job.project_id, job.notebook_id, job.id)).toHaveLength(
				1,
			);
			expect(await services.jobRuns.getMarker(first)).not.toBeNull();
			fault.mockRestore();
			await services.jobRuns.cancel(first, ACTOR);
			await services.jobRuns.deleteMarker(first);
			expect(
				(await expectOk<Page>(await request()('GET', base()))).items.map((run) => run.run_id),
			).toEqual([first.run_id]);
		},
	);

	it('gates the new routes when jobs are disabled', async () => {
		const off = createTestApi({ bucket, deps: { jobs: undefined } }).request;
		await expectError(await off('GET', base()), 404);
		await expectError(await off('POST', `${jobBase()}/history-backfill`), 404);
	});
});
