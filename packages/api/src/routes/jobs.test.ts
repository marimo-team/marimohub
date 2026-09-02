import { beforeEach, describe, expect, it } from 'vitest';
import { createServices, paths, SandboxId } from '@marimo-hub/core';
import type { JobRun, ProjectId, SandboxProvider, UserId } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { DEFAULT_JOBS_CONFIG } from '../context';
import {
	createInitializedBucket,
	createTestApi,
	expectError,
	expectOk,
	expectPage,
} from '../testing';

const VIEWER = uid('viewer-1');
const EDITOR = uid('editor-1');

describe('Job routes', () => {
	let bucket: MemoryBucket;
	let request: ReturnType<typeof createTestApi>['request'];
	let services: ReturnType<typeof createServices>;
	let pid: ProjectId;
	let nid: string;
	let destroyed: string[];

	const as = (userId: UserId) => createTestApi({ bucket, userId, compute }).request;

	let compute: SandboxProvider;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		services = createServices(bucket);
		destroyed = [];
		compute = {
			create: (id) => ({ destroy: async () => void destroyed.push(id) }) as never,
			proxy: async () => null,
		};
		const project = await services.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		await services.projects.addMember(pid, { user_id: VIEWER }, 'viewer', ACTOR);
		await services.projects.addMember(pid, { user_id: EDITOR }, 'editor', ACTOR);
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		request = createTestApi({
			bucket,
			compute,
			deps: { policy: { defaultRole: undefined } },
		}).request;
	});

	const base = () => `/projects/${pid}/notebooks/${nid}/jobs`;
	const createJob = async (body: Record<string, unknown> = { name: 'nightly' }, who = request) =>
		expectOk<any>(await who('POST', base(), body), 201);

	it('creates, lists, reads, updates, and deletes a job with an ETag', async () => {
		const created = await createJob({
			name: 'nightly',
			schedule: { cron: '0 6 * * *', timezone: 'Europe/Berlin' },
			parameters: { region: 'eu' },
			retry: { max_retries: 1 },
			notifications: { on: ['failure'] },
		});
		expect(created).toMatchObject({
			name: 'nightly',
			enabled: true,
			concurrency_policy: 'forbid',
			retry: { max_retries: 1, backoff_seconds: 60 },
			parameters: { region: 'eu' },
			notifications: { on: ['failure'] },
			created_by: ACTOR,
		});
		expect(created.next_run_at).toMatch(/T0[45]:00:00\.000Z$/);

		expect((await expectPage(await request('GET', base()))).map((j) => j.id)).toEqual([created.id]);
		const read = await request('GET', `${base()}/${created.id}`);
		expect(read.headers.get('etag')).toBe(`"${created.updated_at}"`);

		const updated = await expectOk<any>(
			await request(
				'PATCH',
				`${base()}/${created.id}`,
				{ enabled: false, schedule: null, parameters: null },
				{ 'if-match': created.updated_at },
			),
		);
		expect(updated).toMatchObject({ enabled: false, next_run_at: null });
		expect(updated.schedule).toBeUndefined();
		expect(updated.parameters).toBeUndefined();

		await expectError(
			await request(
				'PATCH',
				`${base()}/${created.id}`,
				{ name: 'x' },
				{ 'if-match': created.updated_at },
			),
			412,
			'PRECONDITION_FAILED',
		);

		await expectOk(await request('DELETE', `${base()}/${created.id}`));
		await expectError(await request('GET', `${base()}/${created.id}`), 404, 'NOT_FOUND');
	});

	it('pages job definitions through the cursor', async () => {
		const jobs = [];
		for (let index = 0; index < 3; index++) jobs.push(await createJob({ name: `job ${index}` }));
		const ordered = [...jobs].sort(
			(a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
		);
		const first = await expectOk<{ items: any[]; next_cursor: string | null }>(
			await request('GET', `${base()}?limit=2`),
		);
		expect(first.items.map((job) => job.id)).toEqual(ordered.slice(0, 2).map((job) => job.id));
		expect(first.next_cursor).not.toBeNull();
		const second = await expectOk<{ items: any[]; next_cursor: string | null }>(
			await request('GET', `${base()}?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`),
		);
		expect(second.items.map((job) => job.id)).toEqual([ordered[2].id]);
		expect(second.next_cursor).toBeNull();
		await expectError(await request('GET', `${base()}?cursor=garbage`), 400);
	});

	it('rejects invalid schedules, unknown fields, and over-limit timeouts', async () => {
		await expectError(
			await request('POST', base(), { name: 'x', schedule: { cron: 'nope', timezone: 'UTC' } }),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('POST', base(), {
				name: 'x',
				schedule: { cron: '* * * * *', timezone: 'Mars/Base' },
			}),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('POST', base(), { name: 'x', bogus: true }),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('POST', base(), {
				name: 'x',
				timeout_seconds: DEFAULT_JOBS_CONFIG.maxTimeoutMs / 1000 + 1,
			}),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await request('POST', base(), { name: 'x', notifications: { on: [] } }),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('enforces the per-notebook cap from the deployment config', async () => {
		const capped = createTestApi({
			bucket,
			compute,
			deps: { jobs: { ...DEFAULT_JOBS_CONFIG, maxPerNotebook: 1 } },
		}).request;
		await createJob({ name: 'one' }, capped);
		await expectError(await capped('POST', base(), { name: 'two' }), 429, 'RESOURCE_EXHAUSTED');
	});

	it('applies the role matrix: viewers read, editors mutate', async () => {
		const job = await createJob();
		const viewer = as(VIEWER);
		const editor = as(EDITOR);

		expect(await expectPage(await viewer('GET', base()))).toHaveLength(1);
		await expectOk(await viewer('GET', `${base()}/${job.id}`));
		await expectError(await viewer('POST', base(), { name: 'nope' }), 403, 'FORBIDDEN');
		await expectError(
			await viewer('PATCH', `${base()}/${job.id}`, { name: 'nope' }),
			403,
			'FORBIDDEN',
		);
		await expectError(await viewer('POST', `${base()}/${job.id}/runs`), 403, 'FORBIDDEN');
		await expectError(await viewer('DELETE', `${base()}/${job.id}`), 403, 'FORBIDDEN');

		const run = await expectOk<any>(await editor('POST', `${base()}/${job.id}/runs`), 201);
		expect(run).toMatchObject({ status: 'queued', trigger: 'manual', triggered_by: EDITOR });
		// Run history is viewer-visible; logs and cancel are editor-only.
		expect(await expectPage(await viewer('GET', `${base()}/${job.id}/runs`))).toHaveLength(1);
		await expectOk(await viewer('GET', `${base()}/${job.id}/runs/${run.run_id}`));
		await expectError(
			await viewer('GET', `${base()}/${job.id}/runs/${run.run_id}/logs`),
			403,
			'FORBIDDEN',
		);
		await expectError(
			await viewer('POST', `${base()}/${job.id}/runs/${run.run_id}/cancel`),
			403,
			'FORBIDDEN',
		);
		await expectOk(await editor('POST', `${base()}/${job.id}/runs/${run.run_id}/cancel`));
	});

	it('triggers a run without provisioning and lists runs newest first', async () => {
		const job = await createJob({ name: 'manual', timeout_seconds: 120, parameters: { a: '1' } });
		const first = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
		const second = await expectOk<any>(
			await request('POST', `${base()}/${job.id}/runs`, { parameters: { a: '2' } }),
			201,
		);
		expect(first).toMatchObject({ status: 'queued', timeout_seconds: 120, parameters: { a: '1' } });
		expect(second.parameters).toEqual({ a: '2' });
		expect(first.source_version_id).toMatch(/^ver_/);
		expect(destroyed).toEqual([]);
		expect(await bucket.head(paths.jobRunMarker(pid, first.run_id))).not.toBeNull();

		const runs = await expectPage<any>(await request('GET', `${base()}/${job.id}/runs`));
		expect(runs.map((r) => r.run_id)).toEqual([second.run_id, first.run_id]);
		const page = await expectOk<{ items: any[]; next_cursor: string | null }>(
			await request('GET', `${base()}/${job.id}/runs?limit=1`),
		);
		expect(page.items.map((r) => r.run_id)).toEqual([second.run_id]);
		expect(page.next_cursor).not.toBeNull();
	});

	it('replays a trigger with the same Idempotency-Key', async () => {
		const job = await createJob();
		const headers = { 'idempotency-key': 'trigger-1' };
		const a = await expectOk<any>(
			await request('POST', `${base()}/${job.id}/runs`, undefined, headers),
			201,
		);
		const b = await expectOk<any>(
			await request('POST', `${base()}/${job.id}/runs`, undefined, headers),
			201,
		);
		expect(b.run_id).toBe(a.run_id);
		expect(await expectPage(await request('GET', `${base()}/${job.id}/runs`))).toHaveLength(1);
	});

	it('cancels an active run and destroys its sandbox', async () => {
		const job = await createJob();
		const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
		const sandboxId = SandboxId.parse('sb-0123456789abcdef');
		const jobDefinition = await services.jobs.getJob(pid, nid as never, job.id);
		await services.jobRuns.transition(
			{ ...jobDefinition, run_id: queued.run_id, job_id: job.id } as unknown as JobRun,
			'provision',
			() => ({ sandbox_id: sandboxId }),
		);
		const cancelled = await expectOk<any>(
			await request('POST', `${base()}/${job.id}/runs/${queued.run_id}/cancel`),
		);
		expect(cancelled).toMatchObject({ status: 'cancelled', cancelled_by: ACTOR });
		expect(destroyed).toEqual([sandboxId]);
		const finishEvents = (
			await services.events.getEvents(new Date().toISOString().slice(0, 10))
		).filter((event) => event.event === 'job.run.finish' && event.run_id === queued.run_id);
		expect(finishEvents).toHaveLength(1);
		expect(finishEvents[0]).toMatchObject({ status: 'cancelled', actor: ACTOR });
		const again = await expectOk<any>(
			await request('POST', `${base()}/${job.id}/runs/${queued.run_id}/cancel`),
		);
		expect(again.status).toBe('cancelled');
		expect(destroyed).toHaveLength(1);
	});

	it('audits cancellation of a queued run as a terminal finish', async () => {
		const job = await createJob();
		const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);

		const cancelled = await expectOk<any>(
			await request('POST', `${base()}/${job.id}/runs/${queued.run_id}/cancel`),
		);

		expect(cancelled).toMatchObject({ status: 'cancelled', cancelled_by: ACTOR });
		expect(destroyed).toEqual([]);
		const runEvents = (
			await services.events.getEvents(new Date().toISOString().slice(0, 10))
		).filter((event) => event.run_id === queued.run_id);
		expect(runEvents.filter((event) => event.event === 'job.run.cancel')).toHaveLength(1);
		expect(runEvents.filter((event) => event.event === 'job.run.finish')).toEqual([
			expect.objectContaining({ status: 'cancelled', actor: ACTOR }),
		]);
	});

	it('deleting a job cancels its active runs first', async () => {
		const job = await createJob();
		const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
		await expectOk(await request('DELETE', `${base()}/${job.id}`));
		expect(await bucket.head(paths.jobRunMarker(pid, queued.run_id))).toBeNull();
		expect(await services.jobRuns.listActive()).toEqual([]);
	});

	it('rejects a trigger that overlaps deletion', async () => {
		const job = await createJob();
		const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
		const run = await services.jobRuns.getRun(pid, nid as never, job.id, queued.run_id);
		await services.jobRuns.transition(run, 'provision', () => ({
			sandbox_id: SandboxId.parse('sb-0123456789abcdef'),
		}));
		let releaseDestroy!: () => void;
		const destroyBlocked = new Promise<void>((resolve) => {
			releaseDestroy = resolve;
		});
		let destroyStarted!: () => void;
		const destroying = new Promise<void>((resolve) => {
			destroyStarted = resolve;
		});
		compute.create = (id) =>
			({
				destroy: async () => {
					destroyed.push(id);
					destroyStarted();
					await destroyBlocked;
				},
			}) as never;

		const deleting = request('DELETE', `${base()}/${job.id}`);
		await destroying;
		await expectError(await request('POST', `${base()}/${job.id}/runs`), 404, 'NOT_FOUND');
		releaseDestroy();
		await expectOk(await deleting);
		expect(await services.jobRuns.listActive()).toEqual([]);
	});

	it('serves run output raw and logs to editors, enveloped 404 when absent', async () => {
		const job = await createJob();
		const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
		const runPath = `${base()}/${job.id}/runs/${queued.run_id}`;
		await expectError(await request('GET', `${runPath}/html`), 404, 'NO_RUN_OUTPUT');
		await expectError(await request('GET', `${runPath}/logs`), 404, 'NO_RUN_OUTPUT');

		const run = await services.jobRuns.getRun(pid, nid as never, job.id, queued.run_id);
		await services.jobRuns.putOutputs(run, { html: '<html>out</html>', logs: 'line 1' });

		const html = await request('GET', `${runPath}/html`);
		expect(html.status).toBe(200);
		expect(html.headers.get('content-type')).toContain('text/html');
		expect(html.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
		expect(html.headers.get('x-marimohub-run-id')).toBe(queued.run_id);
		expect(await html.text()).toBe('<html>out</html>');

		const viewerHtml = await as(VIEWER)('GET', `${runPath}/html`);
		expect(viewerHtml.status).toBe(200);

		const logs = await request('GET', `${runPath}/logs`);
		expect(logs.status).toBe(200);
		expect(logs.headers.get('content-type')).toContain('text/plain');
		expect(await logs.text()).toBe('line 1');
	});

	it('404s a run under a different job', async () => {
		const a = await createJob({ name: 'a' });
		const b = await createJob({ name: 'b' });
		const run = await expectOk<any>(await request('POST', `${base()}/${a.id}/runs`), 201);
		await expectError(
			await request('GET', `${base()}/${b.id}/runs/${run.run_id}`),
			404,
			'NOT_FOUND',
		);
	});

	it('hides jobs of a deleted notebook', async () => {
		const job = await createJob();
		await services.notebooks.deleteNotebook(pid, nid as never, ACTOR);
		await expectError(await request('GET', `${base()}/${job.id}`), 404, 'NOT_FOUND');
		await expectError(await request('POST', `${base()}/${job.id}/runs`), 404, 'NOT_FOUND');
	});

	it('bounds how many manual runs may queue up', async () => {
		const job = await createJob();
		for (let i = 0; i < 20; i++) {
			await expectOk(await request('POST', `${base()}/${job.id}/runs`), 201);
		}
		await expectError(await request('POST', `${base()}/${job.id}/runs`), 429, 'RESOURCE_EXHAUSTED');
	});

	it('bounds concurrent manual triggers atomically', async () => {
		const job = await createJob();
		const responses = await Promise.all(
			Array.from({ length: 24 }, () =>
				Promise.resolve(request('POST', `${base()}/${job.id}/runs`)),
			),
		);
		expect(responses.filter((response) => response.status === 201)).toHaveLength(20);
		expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
		expect(await expectPage(await request('GET', `${base()}/${job.id}/runs`))).toHaveLength(20);
	});

	it('advertises the job limits on capabilities', async () => {
		const capabilities = await expectOk<any>(await request('GET', '/capabilities'));
		expect(capabilities.jobs).toEqual({
			available: true,
			max_per_notebook: 5,
			default_timeout_seconds: 1800,
			max_timeout_seconds: 14_400,
			run_retention_days: 30,
		});
	});

	describe('unhappy paths', () => {
		it.each([
			['an empty name', { name: '' }],
			['an over-long name', { name: 'x'.repeat(121) }],
			['a timeout below the minimum', { name: 'x', timeout_seconds: 59 }],
			['a six-field cron', { name: 'x', schedule: { cron: '0 0 0 * * *', timezone: 'UTC' } }],
			['an unknown concurrency policy', { name: 'x', concurrency_policy: 'sometimes' }],
			[
				'duplicate notification events',
				{ name: 'x', notifications: { on: ['failure', 'failure'] } },
			],
			['a parameter key that is not flag-safe', { name: 'x', parameters: { '1abc': 'v' } }],
			[
				'too many parameters',
				{
					name: 'x',
					parameters: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])),
				},
			],
			['too many retries', { name: 'x', retry: { max_retries: 6 } }],
			['an unknown field', { name: 'x', color: 'red' }],
		])('rejects a create with %s', async (_label, body) => {
			await expectError(await request('POST', base(), body), 422, 'VALIDATION_ERROR');
			expect(await expectPage(await request('GET', base()))).toEqual([]);
		});

		it('rejects an empty or invalid update and leaves the job untouched', async () => {
			const job = await createJob();
			await expectError(await request('PATCH', `${base()}/${job.id}`, {}), 422, 'VALIDATION_ERROR');
			await expectError(
				await request('PATCH', `${base()}/${job.id}`, {
					schedule: { cron: 'nope', timezone: 'UTC' },
				}),
				422,
				'VALIDATION_ERROR',
			);
			await expectError(
				await request('PATCH', `${base()}/${job.id}`, { timeout_seconds: 10 }),
				422,
				'VALIDATION_ERROR',
			);
			expect(await expectOk<any>(await request('GET', `${base()}/${job.id}`))).toEqual(job);
		});

		it('404s unknown ids and 422s malformed ones', async () => {
			const job = await createJob();
			await expectError(await request('GET', `${base()}/job-0000000000000000`), 404, 'NOT_FOUND');
			await expectError(await request('GET', `${base()}/not-a-job`), 422, 'VALIDATION_ERROR');
			await expectError(
				await request('GET', `${base()}/${job.id}/runs/run_00000000000000000000000000`),
				404,
				'NOT_FOUND',
			);
			await expectError(
				await request('GET', `${base()}/${job.id}/runs/nope`),
				422,
				'VALIDATION_ERROR',
			);
			await expectError(
				await request('DELETE', `${base()}/job-0000000000000000`),
				404,
				'NOT_FOUND',
			);
			await expectError(
				await request('POST', `${base()}/job-0000000000000000/runs`),
				404,
				'NOT_FOUND',
			);
		});

		it('rejects invalid per-run parameter overrides without enqueueing', async () => {
			const job = await createJob();
			await expectError(
				await request('POST', `${base()}/${job.id}/runs`, { parameters: { 'bad key': 'v' } }),
				422,
				'VALIDATION_ERROR',
			);
			await expectError(
				await request('POST', `${base()}/${job.id}/runs`, { extra: true }),
				422,
				'VALIDATION_ERROR',
			);
			expect(await expectPage(await request('GET', `${base()}/${job.id}/runs`))).toEqual([]);
		});

		it('a per-run parameter override does not change the stored job', async () => {
			const job = await createJob({ name: 'p', parameters: { a: '1' } });
			await expectOk(
				await request('POST', `${base()}/${job.id}/runs`, { parameters: { a: '2' } }),
				201,
			);
			expect((await expectOk<any>(await request('GET', `${base()}/${job.id}`))).parameters).toEqual(
				{ a: '1' },
			);
		});

		it('masks reads as 404 and denies writes 403 for a non-member under a members-only default role', async () => {
			const job = await createJob();
			const stranger = as(uid('stranger'));
			await expectError(await stranger('GET', base()), 404, 'NOT_FOUND');
			await expectError(await stranger('GET', `${base()}/${job.id}`), 404, 'NOT_FOUND');
			await expectError(await stranger('GET', `${base()}/${job.id}/runs`), 404, 'NOT_FOUND');
			// Writes take the editor gate first — the same 403 every notebook write route gives.
			await expectError(await stranger('POST', base(), { name: 'x' }), 403, 'FORBIDDEN');
			await expectError(await stranger('POST', `${base()}/${job.id}/runs`), 403, 'FORBIDDEN');
		});

		it('404s once the project is soft-deleted', async () => {
			const job = await createJob();
			await services.projects.deleteProject(pid, ACTOR);
			await expectError(await request('GET', base()), 404, 'NOT_FOUND');
			await expectError(await request('POST', `${base()}/${job.id}/runs`), 404, 'NOT_FOUND');
		});

		it('replays a create with the same Idempotency-Key instead of creating twice', async () => {
			const headers = { 'idempotency-key': 'create-1' };
			const a = await expectOk<any>(await request('POST', base(), { name: 'once' }, headers), 201);
			const b = await expectOk<any>(await request('POST', base(), { name: 'once' }, headers), 201);
			expect(b.id).toBe(a.id);
			expect(await expectPage(await request('GET', base()))).toHaveLength(1);
		});

		it('still cancels when the sandbox destroy fails', async () => {
			const job = await createJob();
			const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
			const run = await services.jobRuns.getRun(pid, nid as never, job.id, queued.run_id);
			await services.jobRuns.transition(run, 'provision', () => ({
				sandbox_id: SandboxId.parse('sb-0123456789abcdef'),
			}));
			const failingCompute: SandboxProvider = {
				create: () =>
					({
						destroy: async () => {
							throw new Error('provider down');
						},
					}) as never,
				proxy: async () => null,
			};
			const api = createTestApi({ bucket, compute: failingCompute });
			const cancelled = await expectOk<any>(
				await api.request('POST', `${base()}/${job.id}/runs/${queued.run_id}/cancel`),
			);
			expect(cancelled.status).toBe('cancelled');
		});

		it('pages run history through the cursor', async () => {
			const job = await createJob();
			const ids: string[] = [];
			for (let i = 0; i < 3; i++) {
				ids.push(
					(await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201)).run_id,
				);
			}
			const first = await expectOk<{ items: any[]; next_cursor: string | null }>(
				await request('GET', `${base()}/${job.id}/runs?limit=2`),
			);
			expect(first.items.map((r) => r.run_id)).toEqual([ids[2], ids[1]]);
			const second = await expectOk<{ items: any[]; next_cursor: string | null }>(
				await request(
					'GET',
					`${base()}/${job.id}/runs?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`,
				),
			);
			expect(second.items.map((r) => r.run_id)).toEqual([ids[0]]);
			expect(second.next_cursor).toBeNull();
			await expectError(await request('GET', `${base()}/${job.id}/runs?cursor=garbage`), 400);
		});

		it('404s output and logs of a run under another job', async () => {
			const a = await createJob({ name: 'a' });
			const b = await createJob({ name: 'b' });
			const run = await expectOk<any>(await request('POST', `${base()}/${a.id}/runs`), 201);
			await expectError(
				await request('GET', `${base()}/${b.id}/runs/${run.run_id}/html`),
				404,
				'NOT_FOUND',
			);
			await expectError(
				await request('GET', `${base()}/${b.id}/runs/${run.run_id}/logs`),
				404,
				'NOT_FOUND',
			);
		});

		it('keeps the notebook’s other jobs when one is deleted', async () => {
			const a = await createJob({ name: 'a' });
			const b = await createJob({ name: 'b' });
			await expectOk(await request('DELETE', `${base()}/${a.id}`));
			expect((await expectPage<any>(await request('GET', base()))).map((j) => j.id)).toEqual([
				b.id,
			]);
		});

		it('advertises custom job limits on capabilities', async () => {
			const api = createTestApi({
				bucket,
				deps: {
					jobs: {
						...DEFAULT_JOBS_CONFIG,
						maxPerNotebook: undefined,
						defaultTimeoutMs: 600_000 as never,
						runRetentionMs: (7 * 24 * 3_600_000) as never,
					},
				},
			});
			const capabilities = await expectOk<any>(await api.request('GET', '/capabilities'));
			expect(capabilities.jobs).toMatchObject({
				max_per_notebook: null,
				default_timeout_seconds: 600,
				run_retention_days: 7,
			});
		});
	});

	describe('when jobs are off', () => {
		it('answers 404 on the whole surface and advertises the feature as unavailable', async () => {
			const job = await createJob();
			const off = createTestApi({ bucket, deps: { jobs: undefined } }).request;
			await expectError(await off('GET', base()), 404, 'NOT_FOUND');
			await expectError(await off('POST', base(), { name: 'x' }), 404, 'NOT_FOUND');
			await expectError(await off('POST', `${base()}/${job.id}/runs`), 404, 'NOT_FOUND');
			await expectError(
				await off('GET', `${base()}/${job.id}/runs/run_01HXYZ33333RSTUVWXYZABCDEF/logs`),
				404,
				'NOT_FOUND',
			);
			const capabilities = await expectOk<any>(await off('GET', '/capabilities'));
			expect(capabilities.jobs).toEqual({
				available: false,
				max_per_notebook: null,
				default_timeout_seconds: null,
				max_timeout_seconds: null,
				run_retention_days: null,
			});
		});

		it('drops the job alert kinds from the selectable project-alert kinds', async () => {
			const projectAlerts = {
				store: {} as never,
				dispatcher: { dispatch: async () => {} } as never,
				maxDestinations: 10,
			};
			const on = createTestApi({ bucket, deps: { projectAlerts } }).request;
			const off = createTestApi({ bucket, deps: { projectAlerts, jobs: undefined } }).request;
			const onKinds = (await expectOk<any>(await on('GET', '/capabilities'))).project_alerts
				.selectable_kinds as string[];
			const offKinds = (await expectOk<any>(await off('GET', '/capabilities'))).project_alerts
				.selectable_kinds as string[];
			expect(onKinds).toContain('job.run.failed');
			expect(offKinds.some((kind) => kind.startsWith('job.'))).toBe(false);
			expect(offKinds).toEqual(onKinds.filter((kind) => !kind.startsWith('job.')));
		});
	});

	describe('integration with deletes and provenance', () => {
		it('cancels the notebook’s active runs and destroys their sandboxes when the notebook is deleted', async () => {
			const job = await createJob();
			const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
			const active = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
			const run = await services.jobRuns.getRun(pid, nid as never, job.id, active.run_id);
			await services.jobRuns.transition(run, 'provision', () => ({
				sandbox_id: SandboxId.parse('sb-0123456789abcdef'),
			}));

			await expectOk(await request('DELETE', `/projects/${pid}/notebooks/${nid}`));

			expect(destroyed).toEqual(['sb-0123456789abcdef']);
			expect((await services.jobRuns.listActive()).map(({ run }) => run?.status)).toEqual([
				'cancelled',
				'cancelled',
			]);
			for (const id of [queued.run_id, active.run_id]) {
				expect((await services.jobRuns.getRun(pid, nid as never, job.id, id)).status).toBe(
					'cancelled',
				);
			}
		});

		it('cancels every notebook’s runs when the project is deleted', async () => {
			const job = await createJob();
			const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
			await expectOk(await request('DELETE', `/projects/${pid}`));
			expect((await services.jobRuns.getRun(pid, nid as never, job.id, queued.run_id)).status).toBe(
				'cancelled',
			);
			expect((await services.jobRuns.listActive()).map(({ run }) => run?.status)).toEqual([
				'cancelled',
			]);
		});

		it('exposes the image and compute profile a run provisioned with', async () => {
			const job = await createJob();
			const queued = await expectOk<any>(await request('POST', `${base()}/${job.id}/runs`), 201);
			const run = await services.jobRuns.getRun(pid, nid as never, job.id, queued.run_id);
			await services.jobRuns.transition(run, 'provision', () => ({
				image: 'ghcr.io/org/gpu:1',
				compute_profile: 'large',
				compute_resources: { cpu: 4, memory_bytes: 8_000_000, gpu: 'A100' },
			}));
			const read = await expectOk<any>(
				await request('GET', `${base()}/${job.id}/runs/${queued.run_id}`),
			);
			expect(read).toMatchObject({
				image: 'ghcr.io/org/gpu:1',
				compute_profile: 'large',
				compute_resources: { cpu: 4, memory_bytes: 8_000_000, gpu: 'A100' },
			});
		});
	});
});
