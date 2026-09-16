import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogService, MAX_QUEUED_RUNS_PER_JOB, UserId } from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	JobDefinition,
	JobRun,
	NotebookId,
	ProjectId,
} from '@marimo-hub/core';
import { localResourceSecurity } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { externalTokenGrant } from '@marimo-hub/core/token-grants';
import {
	CallToolResultSchema,
	JSONRPCMessageSchema,
	ListToolsResultSchema,
	ProgressNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { makeTestDeps } from '../testing';
import { connectMcpClient } from '../testing/mcp';
import { createApi } from '../createApi';
import { DEFAULT_JOBS_CONFIG } from '../context';

const TOOL_NAMES = ['list_jobs', 'create_job', 'schedule_job', 'run_job', 'get_job_run'];
const publicBaseUrl = 'https://hub.example.com/hub';
const USER: AuthenticatedPrincipal = {
	id: UserId.parse('job-owner'),
	email: 'owner@example.com',
	credential: {
		kind: 'personal-access-token',
		id: 'token',
		oauth: { clientId: 'client', resource: `${publicBaseUrl}/mcp`, scopes: ['mcp:tools'] },
	},
};
const VIEWER: AuthenticatedPrincipal = {
	id: UserId.parse('job-viewer'),
	email: 'viewer@example.com',
	credential: { kind: 'sso' },
};
const requestContext = {
	method: 'POST',
	path: '/mcp',
	hostname: 'hub.example.com',
	appBaseUrl: publicBaseUrl,
};
let deps: ReturnType<typeof makeTestDeps>;
let pid: ProjectId;
let nid: NotebookId;
let job: JobDefinition;
let client: Awaited<ReturnType<typeof connectMcpClient>>;

function selectors() {
	return { project: pid, notebook: nid, job: job.id };
}
async function call(name: string, args: Record<string, unknown> = {}) {
	return CallToolResultSchema.parse(
		await client.callTool({
			name,
			arguments: {
				project: pid,
				notebook: nid,
				...(!['create_job', 'list_jobs', 'get_notebook'].includes(name) ? { job: job.id } : {}),
				...args,
			},
		}),
	);
}
async function enqueue() {
	return deps.services.jobRuns.enqueue({
		job,
		trigger: 'manual',
		triggeredBy: USER.id,
		timeoutSeconds: 60,
	});
}
async function finish(run: JobRun) {
	await deps.services.jobRuns.transition(run, 'provision');
	await deps.services.jobRuns.transition(run, 'start');
	const output = await deps.services.jobRuns.putOutputs(run, {
		html: '<html>Done</html>',
		logs: 'Done',
	});
	return (await deps.services.jobRuns.transition(run, 'succeed', () => ({ output }))).run;
}
function rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
	return createApi(deps).request('/mcp', {
		method: 'POST',
		signal,
		headers: {
			Authorization: 'Bearer test',
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
}
function parseMessages(text: string) {
	return text
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSONRPCMessageSchema.parse(JSON.parse(line.slice(6))));
}
function responseResult(messages: ReturnType<typeof parseMessages>) {
	const response = messages.find((message) => 'result' in message);
	if (!response || !('result' in response)) throw new Error('Missing MCP response');
	return response.result;
}
function progressMessages(messages: ReturnType<typeof parseMessages>) {
	return messages.flatMap((message) => {
		const parsed = ProgressNotificationSchema.safeParse(message);
		return parsed.success ? [parsed.data] : [];
	});
}

beforeEach(async () => {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(USER.id);
	deps = makeTestDeps(bucket, {
		policy: { defaultRole: undefined },
		mcp: { publicBaseUrl },
		authenticator: { authenticate: async () => USER },
	});
	const project = await deps.services.projects.createProject(
		{ name: 'Analytics', description: '' },
		USER.id,
	);
	pid = project.id;
	await deps.services.projects.addMember(pid, { user_id: VIEWER.id }, 'viewer', USER.id);
	nid = (
		await deps.services.notebooks.createNotebook(
			pid,
			{ title: 'Report', description: '', code: 'import marimo' },
			USER.id,
		)
	).id;
	job = await deps.services.jobs.createJob(
		pid,
		nid,
		{ name: 'Nightly', parameters: { region: 'eu', currency: 'eur' } },
		USER.id,
	);
	client = await connectMcpClient(deps, USER, requestContext);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('MCP job registration', () => {
	it.each([true, false])('registers jobs over HTTP only when enabled=%s', async (enabled) => {
		deps.jobs = enabled ? { ...DEFAULT_JOBS_CONFIG } : undefined;
		const response = await rpc('tools/list', {});
		const tools = ListToolsResultSchema.parse(responseResult(parseMessages(await response.text())));
		const names = new Set(tools.tools.map((tool) => tool.name));
		for (const name of TOOL_NAMES) expect(names.has(name)).toBe(enabled);
		if (!enabled) {
			const list = vi.spyOn(deps.services.jobs, 'listJobsPage');
			const enqueueRun = vi.spyOn(deps.services.jobRuns, 'enqueue');
			for (const name of TOOL_NAMES) {
				const reply = CallToolResultSchema.parse(
					responseResult(
						parseMessages(await (await rpc('tools/call', { name, arguments: selectors() })).text()),
					),
				);
				expect(reply.isError).toBe(true);
				expect(reply.content[0]).toMatchObject({
					type: 'text',
					text: expect.stringContaining('not found'),
				});
			}
			expect(list).not.toHaveBeenCalled();
			expect(enqueueRun).not.toHaveBeenCalled();
		}
	});
});

describe('Notebook job discovery', () => {
	it('includes saved jobs and schedules for notebook readers', async () => {
		const schedule = { cron: '0 6 * * *', timezone: 'America/New_York' };
		const scheduled = await deps.services.jobs.createJob(
			pid,
			nid,
			{
				name: 'Morning',
				schedule,
				enabled: false,
			},
			USER.id,
		);
		client = await connectMcpClient(deps, VIEWER, requestContext);
		const response = await call('get_notebook', { project: 'ANALYTICS', notebook: 'report' });
		expect(response.isError).not.toBe(true);
		expect(response.structuredContent).toMatchObject({
			notebook_id: nid,
			code: 'import marimo',
			jobs: expect.arrayContaining([
				expect.objectContaining({
					id: job.id,
					name: 'Nightly',
					enabled: true,
					parameters: job.parameters,
					updated_at: job.updated_at,
				}),
				expect.objectContaining({ id: scheduled.id, name: 'Morning', enabled: false, schedule }),
			]),
		});
		expect(response.structuredContent?.jobs).toEqual(
			(await call('list_jobs')).structuredContent?.items,
		);
		expect(JSON.stringify(response.structuredContent?.jobs)).not.toContain('schema_version');
	});

	it('returns an empty array for a notebook without jobs', async () => {
		const other = await deps.services.notebooks.createNotebook(
			pid,
			{ title: 'Empty', description: '', code: '' },
			USER.id,
		);
		expect(await call('get_notebook', { notebook: other.id })).toMatchObject({
			structuredContent: { notebook_id: other.id, jobs: [] },
		});
	});

	it('omits jobs without reading definitions when the feature is disabled', async () => {
		deps.jobs = undefined;
		const list = vi.spyOn(deps.services.jobs, 'listJobs');
		const response = await call('get_notebook');
		expect(response.isError).not.toBe(true);
		expect(response.structuredContent).not.toHaveProperty('jobs');
		expect(list).not.toHaveBeenCalled();
	});

	it('does not read job definitions for an inaccessible notebook', async () => {
		deps.resourceSecurity = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
		await deps.services.notebooks.setSecurityLabels(
			pid,
			nid,
			{ classification: 'SECRET', compartments: ['restricted'] },
			USER.id,
		);
		const list = vi.spyOn(deps.services.jobs, 'listJobs');
		expect(await call('get_notebook')).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
		expect(list).not.toHaveBeenCalled();
	});
});

describe('MCP job definitions', () => {
	it('resolves names, pages jobs, and rejects invalid cursors', async () => {
		await deps.services.jobs.createJob(pid, nid, { name: 'Weekly' }, USER.id);
		const first = await call('list_jobs', { project: 'ANALYTICS', notebook: 'report', limit: 1 });
		expect(first.isError).not.toBe(true);
		const page = first.structuredContent as { items: JobDefinition[]; next_cursor: string };
		expect(page.items).toHaveLength(1);
		const second = await call('list_jobs', { cursor: page.next_cursor, limit: 1 });
		expect(second.structuredContent).toMatchObject({
			items: [expect.objectContaining({ name: expect.any(String) })],
			next_cursor: null,
		});
		expect(second.structuredContent?.items).not.toEqual(page.items);
		expect((await call('list_jobs', { cursor: 'invalid' })).isError).toBe(true);
		expect((await call('run_job', { job: 'NIGHTLY' })).structuredContent).toMatchObject({
			run: { job_id: job.id },
		});
	});

	it('requires IDs when job names are ambiguous and rejects missing jobs', async () => {
		await deps.services.jobs.createJob(pid, nid, { name: 'NIGHTLY' }, USER.id);
		expect((await call('run_job', { job: 'nightly' })).structuredContent).toMatchObject({
			code: 'BAD_REQUEST',
			message: expect.stringContaining('ambiguous'),
		});
		expect((await call('run_job', { job: 'missing' })).structuredContent).toMatchObject({
			code: 'NOT_FOUND',
		});
		expect((await call('run_job')).isError).not.toBe(true);
	});

	it('creates manual and scheduled jobs with the existing defaults, without enqueuing', async () => {
		const created = await client.callTool({
			name: 'create_job',
			arguments: { project: pid, notebook: nid, name: 'Manual', idempotency_key: 'create' },
		});
		expect(created.structuredContent).toMatchObject({
			job: { name: 'Manual', enabled: true, concurrency_policy: 'forbid' },
		});
		const replay = await client.callTool({
			name: 'create_job',
			arguments: { project: pid, notebook: nid, name: 'Manual', idempotency_key: 'create' },
		});
		expect(replay.structuredContent).toEqual(created.structuredContent);
		const scheduled = await client.callTool({
			name: 'create_job',
			arguments: {
				project: pid,
				notebook: nid,
				name: 'Morning',
				schedule: { cron: '0 6 * * *', timezone: 'America/New_York' },
				retry: { max_retries: 1 },
			},
		});
		expect(scheduled.structuredContent).toMatchObject({
			job: {
				schedule: { cron: '0 6 * * *', timezone: 'America/New_York' },
				retry: { max_retries: 1, backoff_seconds: 60 },
			},
		});
		expect(await deps.services.jobRuns.listActive()).toEqual([]);
	});

	it.each([
		{ schedule: { cron: 'bad', timezone: 'UTC' } },
		{ schedule: { cron: '* * * * *', timezone: 'bad' } },
		{ parameters: { number: 2 } },
		{ timeout_seconds: DEFAULT_JOBS_CONFIG.maxTimeoutMs / 1000 + 1 },
	])('rejects invalid creation fields %j', async (fields) => {
		const response = await client.callTool({
			name: 'create_job',
			arguments: { project: pid, notebook: nid, name: 'Bad', ...fields },
		});
		expect(response.isError).toBe(true);
		expect(await deps.services.jobs.listJobs(pid, nid)).toHaveLength(1);
	});

	it('schedules, pauses, resumes, clears, and rejects stale or empty edits', async () => {
		const schedule = { cron: '0 6 * * *', timezone: 'UTC' };
		const changed = await call('schedule_job', { expected_updated_at: job.updated_at, schedule });
		expect(changed.structuredContent).toMatchObject({
			job: { schedule, parameters: job.parameters, enabled: true },
		});
		expect(
			(await call('schedule_job', { expected_updated_at: job.updated_at, enabled: false }))
				.structuredContent,
		).toMatchObject({ code: 'PRECONDITION_FAILED' });
		for (const fields of [{ enabled: false }, { enabled: true }, { schedule: null }]) {
			const current = await deps.services.jobs.getJob(pid, nid, job.id);
			expect(
				(await call('schedule_job', { expected_updated_at: current.updated_at, ...fields }))
					.isError,
			).not.toBe(true);
			const updated = await deps.services.jobs.getJob(pid, nid, job.id);
			if ('enabled' in fields) expect(updated.enabled).toBe(fields.enabled);
			else expect(updated.schedule).toBeUndefined();
		}
		expect((await call('schedule_job', { expected_updated_at: job.updated_at })).isError).toBe(
			true,
		);
		expect((await call('schedule_job', { enabled: false })).isError).toBe(true);
	});

	it('enforces notebook job limits and deletion fencing', async () => {
		deps.jobs = { ...DEFAULT_JOBS_CONFIG, maxPerNotebook: 1 };
		expect(
			(
				await client.callTool({
					name: 'create_job',
					arguments: { project: pid, notebook: nid, name: 'Extra' },
				})
			).isError,
		).toBe(true);
		await deps.services.jobs.beginDelete(pid, nid, job.id, USER.id, job.updated_at);
		for (const name of ['schedule_job', 'run_job']) {
			expect(
				(await call(name, { enabled: false, expected_updated_at: job.updated_at })).isError,
			).toBe(true);
		}
		expect(await deps.services.jobRuns.listActive()).toEqual([]);
	});
});

describe('MCP run execution and authorization', () => {
	it('pins source, replaces parameters, audits execution, and returns current status on replay', async () => {
		const first = await call('run_job', { parameters: {}, idempotency_key: 'run' });
		const data = first.structuredContent as {
			run: JobRun;
			poll: { arguments: Record<string, unknown> };
		};
		const notebook = await deps.services.notebooks.getNotebook(pid, nid);
		expect(data.run).toMatchObject({
			status: 'queued',
			triggered_by: USER.id,
			source_version_id: notebook.source.current_version_id,
		});
		expect(data.run.parameters).toBeUndefined();
		expect(first.structuredContent).toMatchObject({
			completed: false,
			wait_expired: false,
			poll: { tool: 'get_job_run', interval_seconds: 2 },
			links: {
				status: `${publicBaseUrl}/api/v1/projects/${pid}/notebooks/${nid}/jobs/${job.id}/runs/${data.run.run_id}`,
			},
		});
		expect((await call('get_job_run', data.poll.arguments)).structuredContent).toEqual(
			first.structuredContent,
		);
		await finish(data.run);
		const replay = await call('run_job', { parameters: {}, idempotency_key: 'run' });
		expect(replay.structuredContent).toMatchObject({
			completed: true,
			run: { run_id: data.run.run_id, status: 'succeeded' },
		});
		expect((await deps.services.jobRuns.listRunsPage(pid, nid, job.id, 100)).items).toHaveLength(1);
		const events = await deps.services.events.getEvents(new Date().toISOString().slice(0, 10));
		expect(events.filter((event) => event.event === 'job.run.trigger')).toHaveLength(1);
	});

	it('scopes replay keys to jobs and operations', async () => {
		const other = await deps.services.jobs.createJob(pid, nid, { name: 'Other' }, USER.id);
		await call('run_job', { idempotency_key: 'same' });
		await call('run_job', { job: other.id, idempotency_key: 'same' });
		expect(await deps.services.jobRuns.listActive()).toHaveLength(2);
		expect(
			(
				await client.callTool({
					name: 'create_job',
					arguments: { project: pid, notebook: nid, name: 'New', idempotency_key: 'same' },
				})
			).structuredContent,
		).toMatchObject({ job: { name: 'New' } });
	});

	it('preserves defaults and enforces queue limits', async () => {
		const response = await call('run_job');
		expect(response.structuredContent).toMatchObject({
			run: {
				parameters: job.parameters,
				timeout_seconds: DEFAULT_JOBS_CONFIG.defaultTimeoutMs / 1000,
			},
		});
		for (let i = 1; i < MAX_QUEUED_RUNS_PER_JOB; i++) await enqueue();
		expect((await call('run_job')).structuredContent).toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
	});

	it('allows viewer reads and HTML links but denies mutations and log links', async () => {
		const run = await finish(await enqueue());
		const ownerRead = await call('get_job_run', { run_id: run.run_id });
		expect(ownerRead.structuredContent?.links).toHaveProperty('logs');
		client = await connectMcpClient(deps, VIEWER, requestContext);
		expect((await call('list_jobs')).isError).not.toBe(true);
		const viewerRead = await call('get_job_run', { run_id: run.run_id });
		expect(viewerRead.structuredContent?.links).toHaveProperty('html');
		expect(viewerRead.structuredContent?.links).not.toHaveProperty('logs');
		expect(
			await client.callTool({
				name: 'create_job',
				arguments: { project: pid, notebook: nid, name: 'Blocked' },
			}),
		).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
		for (const name of ['schedule_job', 'run_job']) {
			const response = await call(name, {
				name: 'Blocked',
				enabled: false,
				expected_updated_at: job.updated_at,
			});
			expect(response.isError).toBe(true);
		}
	});

	it('enforces token grants and hides inaccessible projects', async () => {
		const restricted: AuthenticatedPrincipal = {
			...USER,
			credential: { kind: 'external-access-token', grant: externalTokenGrant(['marimohub:read'])! },
		};
		client = await connectMcpClient(deps, restricted, requestContext);
		expect((await call('list_jobs')).isError).not.toBe(true);
		expect((await call('run_job')).isError).toBe(true);
		client = await connectMcpClient(
			deps,
			{ id: UserId.parse('stranger'), email: 'stranger@example.com', credential: { kind: 'sso' } },
			requestContext,
		);
		expect((await call('list_jobs')).structuredContent).toMatchObject({ code: 'NOT_FOUND' });
	});

	it('hides restricted notebooks from every job tool', async () => {
		deps.resourceSecurity = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
		await deps.services.notebooks.setSecurityLabels(
			pid,
			nid,
			{ classification: 'SECRET', compartments: ['restricted'] },
			USER.id,
		);
		const run = await enqueue();
		const toolArguments = {
			list_jobs: {},
			create_job: { name: 'Hidden' },
			schedule_job: { job: job.id, enabled: false, expected_updated_at: job.updated_at },
			run_job: { job: job.id },
			get_job_run: { job: job.id, run_id: run.run_id },
		};
		for (const [name, args] of Object.entries(toolArguments)) {
			expect(
				await client.callTool({ name, arguments: { project: pid, notebook: nid, ...args } }),
			).toMatchObject({
				isError: true,
				structuredContent: { code: 'NOT_FOUND' },
			});
		}
	});

	it('omits HTML links for runs that captured only logs', async () => {
		const run = await enqueue();
		const output = await deps.services.jobRuns.putOutputs(run, { logs: 'Provisioning failed' });
		await deps.services.jobRuns.transition(run, 'fail', () => ({ output }));
		const response = await call('get_job_run', { run_id: run.run_id });
		expect(response.structuredContent?.links).toHaveProperty('logs');
		expect(response.structuredContent?.links).not.toHaveProperty('html');
	});

	it('rejects runs belonging to another job', async () => {
		const run = await enqueue();
		const other = await deps.services.jobs.createJob(pid, nid, { name: 'Other' }, USER.id);
		expect(
			(await call('get_job_run', { job: other.id, run_id: run.run_id })).structuredContent,
		).toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('MCP job edge cases', () => {
	it.each(['create_job', 'schedule_job', 'run_job'])(
		'does not mutate for an already cancelled %s request',
		async (name) => {
			client = await connectMcpClient(deps, USER, {
				...requestContext,
				signal: AbortSignal.abort(),
			});
			const response = await call(
				name,
				name === 'create_job'
					? { name: 'Cancelled' }
					: { enabled: false, expected_updated_at: job.updated_at },
			);
			expect(response).toMatchObject({
				isError: true,
				structuredContent: { code: 'REQUEST_CANCELLED' },
			});
			expect(await deps.services.jobs.listJobs(pid, nid)).toEqual([job]);
			expect(await deps.services.jobRuns.listActive()).toEqual([]);
		},
	);

	it.each(['schedule_job', 'run_job'])(
		'checks cancellation after acquiring the mutation lock for %s',
		async (name) => {
			const controller = new AbortController();
			client = await connectMcpClient(deps, USER, { ...requestContext, signal: controller.signal });
			const original = deps.services.jobRuns.withJobMutation.bind(deps.services.jobRuns);
			vi.spyOn(deps.services.jobRuns, 'withJobMutation').mockImplementation(async (ref, work) => {
				controller.abort();
				return original(ref, work);
			});
			expect(
				await call(name, { enabled: false, expected_updated_at: job.updated_at }),
			).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_CANCELLED' } });
			expect(await deps.services.jobs.getJob(pid, nid, job.id)).toEqual(job);
			expect(await deps.services.jobRuns.listActive()).toEqual([]);
		},
	);

	it('checks cancellation after replay lookup and before creating a job', async () => {
		const controller = new AbortController();
		client = await connectMcpClient(deps, USER, { ...requestContext, signal: controller.signal });
		vi.spyOn(deps.services.idempotency, 'lookup').mockImplementation(async () => {
			controller.abort();
			return null;
		});
		expect(
			await call('create_job', { name: 'Cancelled', idempotency_key: 'cancel' }),
		).toMatchObject({ isError: true, structuredContent: { code: 'REQUEST_CANCELLED' } });
		expect(await deps.services.jobs.listJobs(pid, nid)).toEqual([job]);
	});

	it('records an enqueued run for replay even if the caller disconnects during enqueue', async () => {
		const controller = new AbortController();
		client = await connectMcpClient(deps, USER, { ...requestContext, signal: controller.signal });
		const enqueueRun = deps.services.jobRuns.enqueue.bind(deps.services.jobRuns);
		vi.spyOn(deps.services.jobRuns, 'enqueue').mockImplementationOnce(async (input) => {
			const run = await enqueueRun(input);
			controller.abort();
			return run;
		});
		expect(await call('run_job', { idempotency_key: 'disconnected' })).toMatchObject({
			isError: true,
			structuredContent: { code: 'REQUEST_CANCELLED' },
		});
		const [active] = await deps.services.jobRuns.listActive();
		client = await connectMcpClient(deps, USER, requestContext);
		expect(await call('run_job', { idempotency_key: 'disconnected' })).toMatchObject({
			structuredContent: { run: { run_id: active.run!.run_id } },
		});
		expect(await deps.services.jobRuns.listActive()).toHaveLength(1);
	});
	it('keeps replay keys separate across callers', async () => {
		await deps.services.projects.updateMemberRole(pid, VIEWER.id, 'editor', USER.id);
		await call('run_job', { idempotency_key: 'shared-key' });
		client = await connectMcpClient(deps, VIEWER, requestContext);
		expect((await call('run_job', { idempotency_key: 'shared-key' })).isError).not.toBe(true);
		const runs = (await deps.services.jobRuns.listRunsPage(pid, nid, job.id, 100)).items;
		expect(runs).toHaveLength(2);
		expect(runs.map((run) => run.triggered_by)).toEqual(
			expect.arrayContaining([USER.id, VIEWER.id]),
		);
	});

	it('keeps create replay keys separate across notebooks', async () => {
		const other = await deps.services.notebooks.createNotebook(
			pid,
			{ title: 'Other', description: '', code: '' },
			USER.id,
		);
		for (const notebook of [nid, other.id]) {
			expect(
				await call('create_job', { notebook, name: 'Created', idempotency_key: 'shared-key' }),
			).toMatchObject({ structuredContent: { job: { notebook_id: notebook } } });
		}
		expect(await deps.services.jobs.listJobs(pid, nid)).toHaveLength(2);
		expect(await deps.services.jobs.listJobs(pid, other.id)).toHaveLength(1);
	});

	it('requires mutation authorization before replaying an existing run', async () => {
		await call('run_job', { idempotency_key: 'restricted-replay' });
		client = await connectMcpClient(
			deps,
			{
				...USER,
				credential: {
					kind: 'external-access-token',
					grant: externalTokenGrant(['marimohub:read'])!,
				},
			},
			requestContext,
		);
		expect(await call('run_job', { idempotency_key: 'restricted-replay' })).toMatchObject({
			isError: true,
			structuredContent: { code: 'FORBIDDEN' },
		});
		expect(await deps.services.jobRuns.listActive()).toHaveLength(1);
	});

	it('does not enqueue a replacement when a replayed run was pruned', async () => {
		await call('run_job', { idempotency_key: 'pruned' });
		const [active] = await deps.services.jobRuns.listActive();
		const run = await finish(active.run!);
		await deps.services.jobRuns.deleteMarker(run);
		await deps.services.jobRuns.pruneJob(job, 0, Date.now() + 1000);
		expect(await call('run_job', { idempotency_key: 'pruned' })).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
		expect(await deps.services.jobRuns.listActive()).toEqual([]);
	});

	it('cancels a stalled artifact lookup after the run has finished', async () => {
		const run = await enqueue();
		await deps.services.jobRuns.transition(run, 'fail', () => ({ output: { html_bytes: 0 } }));
		const controller = new AbortController();
		client = await connectMcpClient(deps, USER, { ...requestContext, signal: controller.signal });
		const read = vi
			.spyOn(deps.services.jobRuns, 'readHtml')
			.mockImplementation(() => new Promise(() => {}));
		vi.useFakeTimers();
		const pending = call('get_job_run', { run_id: run.run_id });
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledOnce();
		controller.abort();
		expect(await pending).toMatchObject({
			isError: true,
			structuredContent: { code: 'REQUEST_CANCELLED' },
		});
	});
	it('includes empty stored artifacts and normalizes a trailing base URL slash', async () => {
		const run = await enqueue();
		const output = await deps.services.jobRuns.putOutputs(run, { html: '', logs: '' });
		await deps.services.jobRuns.transition(run, 'fail', () => ({ output }));
		client = await connectMcpClient(deps, USER, {
			...requestContext,
			appBaseUrl: `${publicBaseUrl}/`,
		});
		const status = `${publicBaseUrl}/api/v1/projects/${pid}/notebooks/${nid}/jobs/${job.id}/runs/${run.run_id}`;
		expect(await call('get_job_run', { run_id: run.run_id })).toMatchObject({
			structuredContent: { links: { status, html: `${status}/html`, logs: `${status}/logs` } },
		});
	});
});

describe('MCP waiting', () => {
	it('expires the wait without cancelling, then resumes observation', async () => {
		const run = await enqueue();
		vi.useFakeTimers();
		const pending = call('get_job_run', { run_id: run.run_id, wait: true, wait_seconds: 1 });
		await vi.advanceTimersByTimeAsync(1100);
		expect((await pending).structuredContent).toMatchObject({
			completed: false,
			wait_expired: true,
			run: { status: 'queued' },
		});
		const next = call('get_job_run', { run_id: run.run_id, wait: true });
		await vi.advanceTimersByTimeAsync(1);
		await finish(run);
		await vi.advanceTimersByTimeAsync(2000);
		expect((await next).structuredContent).toMatchObject({
			completed: true,
			wait_expired: false,
			run: { status: 'succeeded' },
		});
	});

	it.each(['fail', 'timeout', 'cancel'] as const)(
		'returns %s as a normal result and does not follow retries',
		async (event) => {
			const run = await enqueue();
			await deps.services.jobRuns.transition(run, event);
			await deps.services.jobRuns.enqueue({
				job,
				trigger: 'manual',
				timeoutSeconds: 60,
				retryOf: run.run_id,
				attempt: 2,
			});
			const response = await call('get_job_run', { run_id: run.run_id, wait: true });
			expect(response.isError).not.toBe(true);
			expect(response.structuredContent).toMatchObject({
				completed: true,
				wait_expired: false,
				run: { run_id: run.run_id, attempt: 1 },
			});
			expect(response.structuredContent).not.toHaveProperty('poll');
		},
	);

	it('returns skipped attempts as completed without output links', async () => {
		const run = await deps.services.jobRuns.writeSkipped({
			job,
			timeoutSeconds: 60,
			reason: { code: 'CONCURRENCY_FORBIDDEN', message: 'Previous run active' },
		});
		const response = await call('get_job_run', { run_id: run.run_id, wait: true });
		expect(response).toMatchObject({
			structuredContent: { completed: true, run: { status: 'skipped' } },
		});
		expect(response.isError).not.toBe(true);
		expect(response.structuredContent?.links).not.toHaveProperty('html');
	});

	it('bounds observation even when a polling read stalls', async () => {
		const run = await enqueue();
		vi.useFakeTimers();
		const read = vi
			.spyOn(deps.services.jobRuns, 'getRun')
			.mockResolvedValueOnce(run)
			.mockImplementation(() => new Promise(() => {}));
		const pending = call('get_job_run', { run_id: run.run_id, wait: true, wait_seconds: 3 });
		await vi.advanceTimersByTimeAsync(3100);
		expect((await pending).structuredContent).toMatchObject({
			completed: false,
			wait_expired: true,
		});
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(4000);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it.each(['membership', 'notebook-labels', 'notebook-deletion'])(
		'stops returning run data after %s changes during a wait',
		async (change) => {
			const run = await enqueue();
			client = await connectMcpClient(deps, VIEWER, requestContext);
			vi.useFakeTimers();
			const pending = call('get_job_run', { run_id: run.run_id, wait: true });
			await vi.advanceTimersByTimeAsync(1);
			if (change === 'membership')
				await deps.services.projects.removeMember(pid, VIEWER.id, USER.id);
			if (change === 'notebook-labels') {
				deps.resourceSecurity = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
				await deps.services.notebooks.setSecurityLabels(
					pid,
					nid,
					{ classification: 'SECRET', compartments: ['restricted'] },
					USER.id,
				);
			}
			if (change === 'notebook-deletion')
				await deps.services.notebooks.deleteNotebook(pid, nid, USER.id);
			await finish(run);
			await vi.advanceTimersByTimeAsync(2000);
			const response = await pending;
			expect(response).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
			expect(response.structuredContent).not.toHaveProperty('run');
		},
	);

	it.each(
		(['get_job_run', 'run_job'] as const).flatMap((tool) =>
			[1, 3].flatMap((waitSeconds) =>
				(['membership', 'notebook-labels', 'notebook-deletion'] as const).map((change) => ({
					tool,
					waitSeconds,
					change,
				})),
			),
		),
	)(
		'rechecks $change before returning an expired $tool wait of $waitSeconds seconds',
		async ({ tool, waitSeconds, change }) => {
			await deps.services.projects.updateMemberRole(pid, VIEWER.id, 'editor', USER.id);
			client = await connectMcpClient(deps, VIEWER, requestContext);
			const args = tool === 'get_job_run' ? { run_id: (await enqueue()).run_id } : {};
			const read = vi.spyOn(deps.services.jobRuns, 'getRun');
			vi.useFakeTimers();
			const pending = call(tool, { ...args, wait: true, wait_seconds: waitSeconds });
			await vi.advanceTimersByTimeAsync((waitSeconds - 1) * 1000 + 1);
			expect(read).toHaveBeenCalledTimes(waitSeconds === 1 ? 1 : 2);
			if (change === 'membership')
				await deps.services.projects.removeMember(pid, VIEWER.id, USER.id);
			if (change === 'notebook-labels') {
				deps.resourceSecurity = localResourceSecurity(['UNCLASSIFIED', 'SECRET']);
				await deps.services.notebooks.setSecurityLabels(
					pid,
					nid,
					{ classification: 'SECRET', compartments: ['restricted'] },
					USER.id,
				);
			}
			if (change === 'notebook-deletion')
				await deps.services.notebooks.deleteNotebook(pid, nid, USER.id);
			await vi.advanceTimersByTimeAsync(1000);
			const response = await pending;
			expect(response).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
			expect(response.structuredContent).not.toHaveProperty('run');
			expect(response.structuredContent).not.toHaveProperty('links');
		},
	);

	it.each(['timeout', 'abort'] as const)(
		'stops a stalled final authorization check on %s without exposing the run',
		async (end) => {
			const run = await enqueue();
			const controller = new AbortController();
			client = await connectMcpClient(deps, USER, { ...requestContext, signal: controller.signal });
			vi.useFakeTimers();
			const pending = call('get_job_run', { run_id: run.run_id, wait: true, wait_seconds: 1 });
			await vi.advanceTimersByTimeAsync(1);
			const read = vi
				.spyOn(deps.services.notebooks, 'getNotebook')
				.mockImplementation(() => new Promise(() => {}));
			await vi.advanceTimersByTimeAsync(1000);
			expect(read).toHaveBeenCalledOnce();
			if (end === 'abort') controller.abort();
			else await vi.advanceTimersByTimeAsync(5000);
			const response = await pending;
			expect(response).toMatchObject({
				isError: true,
				structuredContent: { code: end === 'abort' ? 'REQUEST_CANCELLED' : 'INTERNAL_ERROR' },
			});
			expect(response.structuredContent).not.toHaveProperty('run');
			expect(response.structuredContent).not.toHaveProperty('links');
		},
	);

	it('sanitizes a failed polling read without turning it into a wait expiry', async () => {
		const run = await enqueue();
		vi.useFakeTimers();
		vi.spyOn(deps.services.jobRuns, 'getRun')
			.mockResolvedValueOnce(run)
			.mockRejectedValue(new Error('private provider detail'));
		const pending = call('get_job_run', { run_id: run.run_id, wait: true });
		await vi.advanceTimersByTimeAsync(2001);
		const response = await pending;
		expect(response).toMatchObject({
			isError: true,
			structuredContent: { code: 'INTERNAL_ERROR' },
		});
		expect(JSON.stringify(response)).not.toContain('private provider detail');
	});

	it('does not send duplicate progress for unchanged statuses', async () => {
		const run = await enqueue();
		vi.useFakeTimers();
		const response = await rpc('tools/call', {
			name: 'get_job_run',
			arguments: { ...selectors(), run_id: run.run_id, wait: true },
			_meta: { progressToken: 'changes' },
		});
		const text = response.text();
		await vi.advanceTimersByTimeAsync(2001);
		await deps.services.jobRuns.transition(run, 'provision');
		await vi.advanceTimersByTimeAsync(2000);
		await deps.services.jobRuns.transition(run, 'start');
		await vi.advanceTimersByTimeAsync(2000);
		await finish(run);
		await vi.advanceTimersByTimeAsync(2000);
		const messages = parseMessages(await text);
		expect(progressMessages(messages).map((message) => message.params.progress)).toEqual([
			1, 2, 3, 4,
		]);
		expect(progressMessages(messages).map((message) => message.params.message)).toEqual(
			['queued', 'provisioning', 'running', 'succeeded'].map(
				(status) => `Run ${run.run_id}: ${status}`,
			),
		);
		expect(CallToolResultSchema.parse(responseResult(messages)).structuredContent).toMatchObject({
			completed: true,
		});
	});
	it('waits on a newly triggered run and emits HTTP progress', async () => {
		vi.useFakeTimers();
		const response = await rpc('tools/call', {
			name: 'run_job',
			arguments: { ...selectors(), wait: true },
			_meta: { progressToken: 'new-run' },
		});
		const text = response.text();
		await vi.advanceTimersByTimeAsync(1);
		const [active] = await deps.services.jobRuns.listActive();
		await finish(active.run!);
		await vi.advanceTimersByTimeAsync(2000);
		const messages = parseMessages(await text);
		expect(progressMessages(messages)[0].params).toMatchObject({
			progressToken: 'new-run',
			progress: 1,
		});
		expect(CallToolResultSchema.parse(responseResult(messages)).structuredContent).toMatchObject({
			completed: true,
			run: { status: 'succeeded' },
		});
		expect((await deps.services.jobRuns.listRunsPage(pid, nid, job.id, 100)).items).toHaveLength(1);
	});

	it.each([0, 121])('rejects wait_seconds=%s before enqueueing', async (wait_seconds) => {
		expect((await call('run_job', { wait: true, wait_seconds })).isError).toBe(true);
		expect(await deps.services.jobRuns.listActive()).toEqual([]);
	});

	it.each([true, false])('delivers HTTP progress only with a token=%s', async (withToken) => {
		const run = await enqueue();
		vi.useFakeTimers();
		const response = await rpc('tools/call', {
			name: 'get_job_run',
			arguments: { ...selectors(), run_id: run.run_id, wait: true },
			...(withToken ? { _meta: { progressToken: 0 } } : {}),
		});
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const text = response.text();
		await vi.advanceTimersByTimeAsync(1);
		await finish(run);
		await vi.advanceTimersByTimeAsync(2000);
		const messages = parseMessages(await text);
		const progress = progressMessages(messages);
		expect(progress).toHaveLength(withToken ? 2 : 0);
		if (withToken) {
			expect(progress.map((message) => message.params.progress)).toEqual([1, 2]);
			expect(progress[0].params).toMatchObject({
				progressToken: 0,
				message: expect.stringContaining('queued'),
			});
			expect(progress[1].params.message).toContain('succeeded');
		}
		expect(CallToolResultSchema.parse(responseResult(messages)).structuredContent).toMatchObject({
			completed: true,
		});
	});

	it.each(['stream', 'request'])(
		'stops polling on HTTP %s cancellation, leaving the run queued',
		async (cancellation) => {
			const run = await enqueue();
			vi.useFakeTimers();
			const read = vi.spyOn(deps.services.jobRuns, 'getRun');
			const controller = new AbortController();
			const response = await rpc(
				'tools/call',
				{
					name: 'get_job_run',
					arguments: { ...selectors(), run_id: run.run_id, wait: true },
					_meta: { progressToken: 'disconnect' },
				},
				controller.signal,
			);
			const reader = response.body!.getReader();
			await reader.read();
			if (cancellation === 'stream') await reader.cancel();
			else controller.abort();
			await vi.advanceTimersByTimeAsync(1);
			const reads = read.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(read).toHaveBeenCalledTimes(reads);
			expect((await deps.services.jobRuns.getRun(pid, nid, job.id, run.run_id)).status).toBe(
				'queued',
			);
			if (cancellation === 'request') await reader.cancel();
		},
	);
});
