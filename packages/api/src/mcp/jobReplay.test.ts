import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CatalogService, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, JobDefinition } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { connectMcpClient } from '../testing/mcp';
import { makeTestDeps } from '../testing';

const USER: AuthenticatedPrincipal = {
	id: UserId.parse('job-owner'),
	email: 'owner@example.com',
	credential: { kind: 'sso' },
};
const RunResult = z.object({
	isError: z.literal(false).optional(),
	structuredContent: z.object({ run: z.object({ run_id: z.string() }) }),
});
let deps: ReturnType<typeof makeTestDeps>;
let otherDeps: ReturnType<typeof makeTestDeps>;
let job: JobDefinition;
let client: Awaited<ReturnType<typeof connectMcpClient>>;
let otherClient: Awaited<ReturnType<typeof connectMcpClient>>;

beforeEach(async () => {
	const bucket = new MemoryBucket();
	await new CatalogService(bucket).initialize(USER.id);
	deps = makeTestDeps(bucket);
	otherDeps = makeTestDeps(bucket);
	const project = await deps.services.projects.createProject(
		{ name: 'Jobs', description: '' },
		USER.id,
	);
	const notebook = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Report', description: '', code: 'import marimo' },
		USER.id,
	);
	job = await deps.services.jobs.createJob(project.id, notebook.id, { name: 'Daily' }, USER.id);
	client = await connectMcpClient(deps, USER);
	otherClient = await connectMcpClient(otherDeps, USER);
});
afterEach(() => vi.restoreAllMocks());

function runJob(connection: typeof client, key: string) {
	return connection.callTool({
		name: 'run_job',
		arguments: {
			project: job.project_id,
			notebook: job.notebook_id,
			job: job.id,
			idempotency_key: key,
		},
	});
}

describe('MCP run replay concurrency', () => {
	it.each(['same key', 'different keys'])(
		'serializes replay recording across service instances with %s',
		async (scenario) => {
			let finishRecording!: () => void;
			const recordingGate = new Promise<void>((resolve) => {
				finishRecording = resolve;
			});
			const record = deps.services.idempotency.record.bind(deps.services.idempotency);
			const recording = vi
				.spyOn(deps.services.idempotency, 'record')
				.mockImplementation(async (...args) => {
					await recordingGate;
					return record(...args);
				});
			const otherMutation = vi.spyOn(otherDeps.services.jobRuns, 'withJobMutation');
			const firstAudit = vi.spyOn(deps.services.events, 'append');
			const secondAudit = vi.spyOn(otherDeps.services.events, 'append');
			const first = runJob(client, 'first');
			await vi.waitFor(() => expect(recording).toHaveBeenCalledOnce());
			const second = runJob(otherClient, scenario === 'same key' ? 'first' : 'second');
			try {
				await vi.waitFor(() => expect(otherMutation).toHaveBeenCalledOnce());
			} finally {
				finishRecording();
			}
			const results = (await Promise.all([first, second])).map((result) => RunResult.parse(result));
			const expectedRuns = scenario === 'same key' ? 1 : 2;
			expect(new Set(results.map((result) => result.structuredContent.run.run_id)).size).toBe(
				expectedRuns,
			);
			expect(await deps.services.jobRuns.listActive()).toHaveLength(expectedRuns);
			expect(
				[...firstAudit.mock.calls, ...secondAudit.mock.calls].filter(
					([event]) => event.event === 'job.run.trigger',
				),
			).toHaveLength(expectedRuns);
		},
	);

	it('releases the mutation claim when a replay read is cancelled', async () => {
		const original = RunResult.parse(await runJob(client, 'cancelled-replay'));
		const controller = new AbortController();
		const cancelledClient = await connectMcpClient(deps, USER, {
			method: 'POST',
			path: '/mcp',
			hostname: 'hub.example.com',
			appBaseUrl: 'https://hub.example.com',
			signal: controller.signal,
		});
		const read = vi
			.spyOn(deps.services.jobRuns, 'getRun')
			.mockImplementationOnce(() => new Promise(() => {}));
		const pending = runJob(cancelledClient, 'cancelled-replay');
		await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
		controller.abort();
		expect(await pending).toMatchObject({
			isError: true,
			structuredContent: { code: 'REQUEST_CANCELLED' },
		});
		const retry = RunResult.parse(await runJob(otherClient, 'cancelled-replay'));
		expect(retry.structuredContent.run.run_id).toBe(original.structuredContent.run.run_id);
		expect(await deps.services.jobRuns.listActive()).toHaveLength(1);
	});

	it('releases the mutation claim after a failed enqueue without consuming the replay key', async () => {
		vi.spyOn(deps.services.jobRuns, 'enqueue').mockRejectedValueOnce(
			new Error('Storage unavailable'),
		);
		expect(await runJob(client, 'retry')).toMatchObject({ isError: true });
		const retry = RunResult.parse(await runJob(otherClient, 'retry'));
		const replay = RunResult.parse(await runJob(client, 'retry'));
		expect(replay.structuredContent.run.run_id).toBe(retry.structuredContent.run.run_id);
		expect(await deps.services.jobRuns.listActive()).toHaveLength(1);
	});
});
