import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BadRequestError,
	CatalogService,
	ForbiddenError,
	JobId,
	NotebookId,
	NotFoundError,
	ProjectId,
	UserId,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, JobDefinition, Project } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { CallToolResultSchema, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeTestDeps } from '../testing';
import { createApi } from '../createApi';
import { resolveNotebook, resolveProject } from './selectors';

const USER: AuthenticatedPrincipal = {
	id: UserId.parse('selector-owner'),
	email: 'owner@example.com',
	credential: {
		kind: 'personal-access-token',
		id: 'token',
		oauth: { clientId: 'client', resource: 'https://hub.example.com/mcp', scopes: ['mcp:tools'] },
	},
};
let deps: ReturnType<typeof makeTestDeps>;
let project: Project;
let notebookId: NotebookId;

beforeEach(async () => {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(USER.id);
	deps = makeTestDeps(bucket, {
		policy: { defaultRole: undefined },
		mcp: { publicBaseUrl: 'https://hub.example.com' },
		authenticator: { authenticate: async () => USER },
	});
	project = await createProject('Analytics');
	notebookId = (await createNotebook('Report')).id;
});
afterEach(() => vi.restoreAllMocks());

function createProject(name: string, owner = USER.id) {
	return deps.services.projects.createProject({ name, description: '' }, owner);
}
function createNotebook(title: string) {
	return deps.services.notebooks.createNotebook(
		project.id,
		{ title, description: '', code: 'import marimo' },
		USER.id,
	);
}
function createJob(name: string) {
	return deps.services.jobs.createJob(project.id, notebookId, { name }, USER.id);
}

async function readRun(job: JobDefinition, reference: string) {
	const run = await deps.services.jobRuns.enqueue({
		job,
		trigger: 'manual',
		triggeredBy: USER.id,
		timeoutSeconds: 60,
	});
	const response = await createApi(deps).request('/mcp', {
		method: 'POST',
		headers: {
			Authorization: 'Bearer test',
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'get_job_run',
				arguments: {
					project: project.id,
					notebook: notebookId,
					job: reference,
					run_id: run.run_id,
				},
			},
		}),
	});
	const messages = (await response.text())
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSONRPCMessageSchema.parse(JSON.parse(line.slice(6))));
	const message = messages.find((item) => 'result' in item);
	if (!message || !('result' in message)) throw new Error('Missing MCP response');
	return CallToolResultSchema.parse(message.result);
}

describe('ID-shaped project names', () => {
	it('falls back to an exact case-insensitive name when the ID is missing', async () => {
		const reference = ProjectId.create();
		const named = await createProject(reference.toUpperCase());
		expect(await resolveProject(deps, USER, reference)).toMatchObject({ id: named.id });
	});

	it('prefers an accessible ID over a matching name', async () => {
		await createProject(project.id);
		expect(await resolveProject(deps, USER, project.id)).toMatchObject({ id: project.id });
	});

	it('falls back to a visible name when the ID is inaccessible', async () => {
		const hidden = await createProject('Hidden', UserId.parse('other-owner'));
		const named = await createProject(hidden.id);
		expect(await resolveProject(deps, USER, hidden.id)).toMatchObject({ id: named.id });
	});

	it('requires an ID when fallback names are ambiguous', async () => {
		const reference = ProjectId.create();
		await createProject(reference);
		await createProject(reference.toUpperCase());
		await expect(resolveProject(deps, USER, reference)).rejects.toBeInstanceOf(BadRequestError);
	});

	it('returns not found when neither the ID nor a name matches', async () => {
		await expect(resolveProject(deps, USER, ProjectId.create())).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	it.each([new ForbiddenError(), new Error('Storage unavailable')])(
		'does not fall back after %s',
		async (error) => {
			vi.spyOn(deps.services.projects, 'getProject').mockRejectedValueOnce(error);
			const list = vi.spyOn(deps.services.projects, 'listProjects');
			await expect(resolveProject(deps, USER, ProjectId.create())).rejects.toBe(error);
			expect(list).not.toHaveBeenCalled();
		},
	);
});

describe('ID-shaped notebook titles', () => {
	it('falls back to an exact case-insensitive title when the ID is missing', async () => {
		const reference = NotebookId.create();
		const named = await createNotebook(reference.toUpperCase());
		expect(await resolveNotebook(deps, USER, project, reference)).toMatchObject({ id: named.id });
	});

	it('prefers an accessible ID over a matching title', async () => {
		await createNotebook(notebookId);
		expect(await resolveNotebook(deps, USER, project, notebookId)).toMatchObject({
			id: notebookId,
		});
	});

	it('requires an ID when fallback titles are ambiguous', async () => {
		const reference = NotebookId.create();
		await createNotebook(reference);
		await createNotebook(reference.toUpperCase());
		await expect(resolveNotebook(deps, USER, project, reference)).rejects.toBeInstanceOf(
			BadRequestError,
		);
	});

	it('returns not found when neither the ID nor a title matches', async () => {
		await expect(resolveNotebook(deps, USER, project, NotebookId.create())).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});
});

describe('ID-shaped job names over HTTP', () => {
	it('falls back to an exact case-insensitive name when the ID is missing', async () => {
		const reference = JobId.create();
		const named = await createJob(reference.toUpperCase());
		expect(await readRun(named, reference)).toMatchObject({
			structuredContent: { run: { job_id: named.id } },
		});
	});

	it('prefers an existing ID over a matching name', async () => {
		const original = await createJob('Nightly');
		await createJob(original.id);
		expect(await readRun(original, original.id)).toMatchObject({
			structuredContent: { run: { job_id: original.id } },
		});
	});

	it('requires an ID when fallback names are ambiguous', async () => {
		const reference = JobId.create();
		const named = await createJob(reference);
		await createJob(reference.toUpperCase());
		expect(await readRun(named, reference)).toMatchObject({
			isError: true,
			structuredContent: { code: 'BAD_REQUEST', message: expect.stringContaining('ambiguous') },
		});
	});

	it('returns not found when neither the ID nor a name matches', async () => {
		expect(await readRun(await createJob('Nightly'), JobId.create())).toMatchObject({
			isError: true,
			structuredContent: { code: 'NOT_FOUND' },
		});
	});

	it.each([
		{ error: new ForbiddenError(), code: 'FORBIDDEN' },
		{ error: new Error('Storage unavailable'), code: 'INTERNAL_ERROR' },
	])('does not fall back after $code', async ({ error, code }) => {
		const job = await createJob('Nightly');
		vi.spyOn(deps.services.jobs, 'getJob').mockRejectedValueOnce(error);
		const list = vi.spyOn(deps.services.jobs, 'listJobs');
		expect(await readRun(job, job.id)).toMatchObject({
			isError: true,
			structuredContent: { code },
		});
		expect(list).not.toHaveBeenCalled();
	});
});
