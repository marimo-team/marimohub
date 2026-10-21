import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeAuthenticators, expandTokenGrantPreset, TokenService } from '@marimo-hub/core';
import type {
	createServices,
	JobDefinition,
	ProjectId,
	NotebookId,
	TokenGrant,
	UserId,
} from '@marimo-hub/core';
import { ACTOR, uid, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

describe('Job webhook triggers', () => {
	let api: ReturnType<typeof createTestApi>;
	let admin: ReturnType<typeof createTestApi>;
	let services: ReturnType<typeof createServices>;
	let pid: ProjectId;
	let nid: NotebookId;
	let job: JobDefinition;
	let token: string;
	const inbound = () => `/api/v1/projects/${pid}/notebooks/${nid}/jobs/${job.id}/trigger`;
	const jobPath = () => `/projects/${pid}/notebooks/${nid}/jobs/${job.id}`;
	const trigger = (body: unknown = {}, credential: string | null = token) =>
		api.app.request(inbound(), {
			method: 'POST',
			body: JSON.stringify(body),
			headers: {
				'content-type': 'application/json',
				...(credential ? { authorization: `Bearer ${credential}` } : {}),
			},
		});
	const mint = (
		grant: TokenGrant = { actions: ['job.trigger'], projects: [pid] },
		userId: UserId = ACTOR,
	) => services.tokens.create({ name: 'ci', grant }, userId);
	const runs = () => services.jobRuns.listRuns(pid, nid, job.id);
	beforeEach(async () => {
		const bucket = await createInitializedBucket();
		admin = createTestApi({ bucket, deps: { policy: { defaultRole: undefined } } });
		services = admin.deps.services;
		await admin.request('GET', '/me');
		const project = await services.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		job = await services.jobs.createJob(
			pid,
			nid,
			{ name: 'hook', parameters: { region: 'eu' } },
			ACTOR,
		);
		api = createTestApi({
			bucket,
			deps: {
				...admin.deps,
				authenticator: composeAuthenticators(services.tokens, { authenticate: async () => null }),
			},
		});
		token = (await mint()).token;
	});
	afterEach(() => vi.restoreAllMocks());

	it('accepts a trigger-only PAT, attributes the owner, and forwards JSON events', async () => {
		const response = await trigger({ event: { key: 'input.csv', count: 2 } });
		const data = await expectOk<{ run_id: string; queued: boolean }>(response, 202);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(data.queued).toBe(true);
		expect(await runs()).toMatchObject([
			{
				run_id: data.run_id,
				trigger: 'webhook',
				triggered_by: ACTOR,
				trigger_source: { kind: 'webhook' },
				parameters: { region: 'eu', event: '{"key":"input.csv","count":2}' },
			},
		]);
	});
	it('rejects missing, malformed, and old per-job credentials without creating a run', async () => {
		for (const credential of [null, 'bad', `mhtrig_${'a'.repeat(43)}`, 'mhub_pat_invalid']) {
			await expectError(await trigger({}, credential), 401, 'UNAUTHORIZED');
		}
		expect(await runs()).toHaveLength(0);
	});
	it('uses the normal CSRF guard for browser requests', async () => {
		const response = await admin.app.request(inbound(), {
			method: 'POST',
			headers: { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' },
		});
		await expectError(response, 403, 'FORBIDDEN');
		expect(await runs()).toHaveLength(0);
	});
	it('rejects a PAT without job.trigger and does not allow a trigger PAT to edit', async () => {
		const read = await mint({ actions: ['project.read', 'notebook.write'], projects: [pid] });
		await expectError(await trigger({}, read.token), 403, 'FORBIDDEN');
		await expectError(
			await api.request(
				'PATCH',
				jobPath(),
				{ name: 'forbidden' },
				{
					authorization: `Bearer ${token}`,
					'if-match': job.updated_at,
				},
			),
			403,
			'FORBIDDEN',
		);
		expect(await runs()).toHaveLength(0);
	});
	it('enforces selected-project restrictions even when the owner can access both projects', async () => {
		const other = await services.projects.createProject({ name: 'other', description: '' }, ACTOR);
		const restricted = await mint({ actions: ['job.trigger'], projects: [other.id] });
		await expectError(await trigger({}, restricted.token), 404, 'NOT_FOUND');
		expect(await runs()).toHaveLength(0);
	});
	it('does not elevate viewers through a trigger grant', async () => {
		const viewer = uid('viewer');
		await createTestApi({ bucket: api.bucket, userId: viewer }).request('GET', '/me');
		await services.projects.addMember(pid, { user_id: viewer }, 'viewer', ACTOR);
		const issued = await mint(
			{ actions: expandTokenGrantPreset('trigger'), projects: [pid] },
			viewer,
		);
		await expectError(await trigger({}, issued.token), 403, 'FORBIDDEN');
		expect(await runs()).toHaveLength(0);
	});
	it('rechecks membership before replaying a previous request', async () => {
		const editor = uid('editor');
		await createTestApi({ bucket: api.bucket, userId: editor }).request('GET', '/me');
		await services.projects.addMember(pid, { user_id: editor }, 'editor', ACTOR);
		const issued = await mint({ actions: ['job.trigger'], projects: [pid] }, editor);
		const body = { idempotency_key: 'membership' };
		await expectOk(await trigger(body, issued.token), 202);
		await services.projects.removeMember(pid, editor, ACTOR);
		await expectError(await trigger(body, issued.token), 403, 'FORBIDDEN');
		expect(await runs()).toHaveLength(1);
	});
	it('rechecks authorization after waiting for the job claim', async () => {
		const lock = services.jobRuns.withJobMutation.bind(services.jobRuns);
		vi.spyOn(services.jobRuns, 'withJobMutation').mockImplementationOnce(async (ref, work) => {
			await services.projects.deleteProject(pid, ACTOR);
			return lock(ref, work);
		});
		await expectError(await trigger(), 404, 'NOT_FOUND');
		expect(await runs()).toHaveLength(0);
	});
	it('applies notebook security labels even to a project owner with a trigger PAT', async () => {
		await services.notebooks.setSecurityLabels(
			pid,
			nid,
			{ classification: 'SECRET', compartments: ['restricted'] },
			ACTOR,
		);
		api = createTestApi({
			bucket: api.bucket,
			deps: {
				...api.deps,
				resourceSecurity: localResourceSecurity(
					['UNCLASSIFIED', 'SECRET'],
					makeSubjectContext({ compartments: [] }),
				),
			},
		});
		await expectError(await trigger(), 404, 'NOT_FOUND');
		expect(await runs()).toHaveLength(0);
	});
	it('rejects revoked and expired PATs before replay', async () => {
		const issued = await mint();
		const body = { idempotency_key: 'revocation' };
		await expectOk(await trigger(body, issued.token), 202);
		await services.tokens.revoke(ACTOR, issued.record.id);
		await expectError(await trigger(body, issued.token), 401, 'UNAUTHORIZED');
		const expired = await services.tokens.create(
			{ name: 'expired', expiresInDays: 0, grant: { actions: ['job.trigger'], projects: [pid] } },
			ACTOR,
		);
		await expectError(await trigger(body, expired.token), 401, 'UNAUTHORIZED');
		expect(await runs()).toHaveLength(1);
	});
	it('honors revocation on another replica after the existing PAT cache TTL', async () => {
		const issued = await mint();
		await expectOk(await trigger({}, issued.token), 202);
		const replica = createTestApi({ bucket: api.bucket }).deps.services;
		await replica.tokens.revoke(ACTOR, issued.record.id);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TokenService.CACHE_TTL_MS + 1);
		await expectError(await trigger({}, issued.token), 401, 'UNAUTHORIZED');
		expect(await runs()).toHaveLength(1);
	});
	it('rejects a suspended owner before replay', async () => {
		const body = { idempotency_key: 'suspension' };
		await expectOk(await trigger(body), 202);
		await services.identities.setSuspension(ACTOR, true);
		await expectError(await trigger(body), 401, 'UNAUTHORIZED');
		expect(await runs()).toHaveLength(1);
	});
	it('deduplicates simultaneous requests and accepts reordered JSON properties', async () => {
		const body = { idempotency_key: 'event-1', event: { key: 'a', count: 1 } };
		const [a, b] = await Promise.all([trigger(body), trigger(body)]);
		const first = await expectOk(a, 202);
		expect(await expectOk(b, 202)).toEqual(first);
		expect(await expectOk(await trigger({ ...body, event: { count: 1, key: 'a' } }), 202)).toEqual(
			first,
		);
		await expectError(await trigger({ ...body, event: { key: 'b' } }), 422, 'VALIDATION_ERROR');
		expect(await runs()).toHaveLength(1);
	});
	it('shares replay across the same owner’s PATs but isolates different owners and jobs', async () => {
		const body = { idempotency_key: 'shared' };
		const first = await expectOk(await trigger(body), 202);
		const replacement = await mint();
		expect(await expectOk(await trigger(body, replacement.token), 202)).toEqual(first);
		const editor = uid('editor');
		await createTestApi({ bucket: api.bucket, userId: editor }).request('GET', '/me');
		await services.projects.addMember(pid, { user_id: editor }, 'editor', ACTOR);
		const other = await mint({ actions: ['job.trigger'], projects: [pid] }, editor);
		expect(await expectOk(await trigger(body, other.token), 202)).not.toEqual(first);
		job = await services.jobs.createJob(pid, nid, { name: 'other' }, ACTOR);
		expect(await expectOk(await trigger(body), 202)).not.toEqual(first);
	});
	it('recovers an enqueue that succeeded before its response failed', async () => {
		const enqueue = services.jobRuns.enqueue.bind(services.jobRuns);
		vi.spyOn(services.jobRuns, 'enqueue').mockImplementationOnce(async (input) => {
			await enqueue(input);
			throw new Error('response interrupted');
		});
		expect((await trigger({ idempotency_key: 'recover' })).status).toBe(500);
		await expectOk(await trigger({ idempotency_key: 'recover' }), 202);
		expect(await runs()).toHaveLength(1);
	});
	it.each(['budget', 'receipt', 'run'] as const)(
		'recovers a failed %s write without duplicating a run',
		async (stage) => {
			const put = api.bucket.put.bind(api.bucket);
			let interrupted = false;
			vi.spyOn(api.bucket, 'put').mockImplementation(async (key, value, options) => {
				const matches =
					stage === 'budget'
						? key.endsWith('/job.json')
						: stage === 'receipt'
							? key.startsWith('_system/idempotency/')
							: key.endsWith('/run.json');
				if (matches && !interrupted) {
					interrupted = true;
					throw new Error('storage interrupted');
				}
				return put(key, value, options);
			});
			const body = { idempotency_key: 'storage' };
			expect((await trigger(body)).status).toBe(500);
			expect(await runs()).toHaveLength(0);
			const recovered = await expectOk(await trigger(body), 202);
			expect(await expectOk(await trigger(body), 202)).toEqual(recovered);
			expect(await runs()).toHaveLength(1);
			expect((await services.jobRuns.listActiveSnapshot()).entries).toHaveLength(1);
		},
	);
	it('enforces queue capacity during recovery while allowing completed requests to replay', async () => {
		vi.spyOn(services.jobRuns, 'enqueue').mockRejectedValueOnce(new Error('enqueue interrupted'));
		expect((await trigger({ idempotency_key: 'recover' })).status).toBe(500);
		const body = { idempotency_key: 'queued' };
		const first = await expectOk(await trigger(body), 202);
		for (let i = 1; i < 20; i++) await expectOk(await trigger(), 202);
		expect(await expectOk(await trigger(body), 202)).toEqual(first);
		await expectError(await trigger(), 429, 'RESOURCE_EXHAUSTED');
		await expectError(await trigger({ idempotency_key: 'recover' }), 429, 'RESOURCE_EXHAUSTED');
		const [run] = await runs();
		await services.jobRuns.cancel(run, ACTOR);
		await expectOk(await trigger({ idempotency_key: 'recover' }), 202);
		expect(await runs()).toHaveLength(21);
	});
	it('fails closed on an incomplete active-run listing without consuming the budget', async () => {
		vi.spyOn(services.jobRuns, 'listActiveSnapshot').mockResolvedValueOnce({
			entries: [],
			complete: false,
		});
		await expectError(await trigger({ idempotency_key: 'incomplete' }), 503, 'SERVICE_UNAVAILABLE');
		expect(await runs()).toHaveLength(0);
		expect((await services.jobs.getJob(pid, nid, job.id)).webhook_admissions).toBeUndefined();
		await expectOk(await trigger({ idempotency_key: 'incomplete' }), 202);
	});
	it.each([
		['array event', { event: [] }],
		['null event', { event: null }],
		['string event', { event: 'not an object' }],
		['unknown field', { unexpected: true }],
		['empty idempotency key', { idempotency_key: '' }],
		['long idempotency key', { idempotency_key: 'x'.repeat(201) }],
		['oversized parameter', { parameters: { text: 'x'.repeat(4097) } }],
	])('rejects %s without enqueuing', async (_label, body) => {
		await expectError(await trigger(body), 422, 'VALIDATION_ERROR');
		expect(await runs()).toHaveLength(0);
	});
	it('enforces event size in UTF-8 bytes, including the exact boundary', async () => {
		await expectOk(await trigger({ event: { text: 'x'.repeat(16 * 1024 - 11) } }), 202);
		await expectError(
			await trigger({ event: { text: 'x'.repeat(16 * 1024 - 10) } }),
			400,
			'BAD_REQUEST',
		);
		await expectError(await trigger({ event: { text: '😀'.repeat(4096) } }), 400, 'BAD_REQUEST');
		expect(await runs()).toHaveLength(1);
	});
	it('rejects too many merged parameters and preserves explicit event precedence', async () => {
		const parameters = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`key${i}`, 'v']));
		await expectError(await trigger({ parameters, event: {} }), 400, 'BAD_REQUEST');
		await expectOk(await trigger({ parameters: { event: 'old' }, event: { key: 'new' } }), 202);
		expect((await runs())[0].parameters).toEqual({ event: '{"key":"new"}' });
	});
	it('accepts an empty body and rejects malformed or oversized bodies without Content-Type', async () => {
		const request = (body?: string) =>
			api.app.request(inbound(), {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
				body,
			});
		await expectOk(await request(), 202);
		await expectError(await request('{'), 400, 'BAD_REQUEST');
		await expectError(await request('x'.repeat(600 * 1024 + 1)), 413, 'PAYLOAD_TOO_LARGE');
		expect(await runs()).toHaveLength(1);
	});
	it.each(['job', 'notebook', 'project', 'deleting'] as const)(
		'rejects disabled or deleted %s, including replay',
		async (kind) => {
			const body = { idempotency_key: 'lifecycle' };
			await expectOk(await trigger(body), 202);
			if (kind === 'job')
				await services.jobs.updateJob(pid, nid, job.id, { enabled: false }, ACTOR);
			if (kind === 'notebook') await services.notebooks.deleteNotebook(pid, nid, ACTOR);
			if (kind === 'project') await services.projects.deleteProject(pid, ACTOR);
			if (kind === 'deleting') await services.jobs.beginDelete(pid, nid, job.id, ACTOR);
			await expectError(await trigger(body), 404, 'NOT_FOUND');
		},
	);
	it('returns 404 while jobs are disabled', async () => {
		const off = createTestApi({ bucket: api.bucket, deps: { ...api.deps, jobs: undefined } });
		await expectError(
			await off.app.request(inbound(), {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			}),
			404,
			'NOT_FOUND',
		);
	});
	it('shares the 60-admission budget across callers and replicas without charging replay', async () => {
		const body = { idempotency_key: 'budget' };
		const first = await expectOk(await trigger(body), 202);
		for (let i = 1; i <= 60; i++) {
			for (const { run } of await services.jobRuns.listActive())
				if (run) {
					await services.jobRuns.cancel(run, ACTOR);
					await services.jobRuns.deleteMarker(run);
				}
			if (i < 60) await expectOk(await trigger(), 202);
		}
		const replacement = await mint();
		const replica = createTestApi({ bucket: api.bucket });
		api = createTestApi({
			bucket: api.bucket,
			deps: {
				policy: { defaultRole: undefined },
				authenticator: composeAuthenticators(replica.deps.services.tokens, {
					authenticate: async () => null,
				}),
			},
		});
		expect(await expectOk(await trigger(body, replacement.token), 202)).toEqual(first);
		await expectError(await trigger({}, replacement.token), 429, 'RESOURCE_EXHAUSTED');
	});
	it('requires target trigger authorization when saving a chain', async () => {
		const target = await services.jobs.createJob(pid, nid, { name: 'target' }, ACTOR);
		const editOnly = await mint({ actions: ['project.read', 'notebook.write'], projects: [pid] });
		const body = { chain: { on_success: [{ notebook_id: nid, job_id: target.id }] } };
		await expectError(
			await api.request('PATCH', jobPath(), body, {
				authorization: `Bearer ${editOnly.token}`,
				'if-match': job.updated_at,
			}),
			403,
			'FORBIDDEN',
		);
		await expectOk(await admin.request('PATCH', jobPath(), body, { 'if-match': job.updated_at }));
	});
});
