import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	BadRequestError,
	foldCase,
	JobId,
	NotFoundError,
	RunId,
	toPublicJobDefinition,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { idempotentOperation } from '../idempotency';
import {
	createNotebookJob,
	listNotebookJobs,
	requireJobs,
	triggerJobRun,
	updateNotebookJob,
} from '../jobs/operations';
import type { AuthorizedNotebook } from '../jobs/operations';
import { CreateJobBody, JobScheduleShape, TriggerRunBody } from '../jobs/schemas';
import { IdempotencyKeyHeader } from '../shared';
import { observeJobRun, WaitShape } from './jobRuns';
import type { JobToolExtra } from './jobRuns';
import { result, toolError } from './results';
import type { ToolResult } from './results';
import {
	resolveAuthorizedNotebook,
	PROJECT_REFERENCE_DESCRIPTION,
	NOTEBOOK_REFERENCE_DESCRIPTION,
} from './selectors';
import type { StartRequestContext } from './server';

const NotebookSelector = z.object({
	project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
	notebook: z.string().describe(NOTEBOOK_REFERENCE_DESCRIPTION),
});
const JobSelector = NotebookSelector.extend({
	job: z
		.string()
		.describe(
			'Job ID or exact job name in the notebook (case-insensitive). Use an ID if names are duplicated.',
		),
});
const IdempotencyShape = { idempotency_key: IdempotencyKeyHeader.shape['idempotency-key'] };
type JobAction = 'project.read' | 'notebook.write';
interface ToolContext {
	target: AuthorizedNotebook;
	extra: JobToolExtra;
	signal: AbortSignal;
}

async function resolveJob(deps: ApiDeps, target: AuthorizedNotebook, value: string) {
	const pid = target.project.id;
	const nid = target.notebook.meta.id;
	if (JobId.is(value)) {
		try {
			return await deps.services.jobs.getJob(pid, nid, value);
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
		}
	}
	const jobs = await deps.services.jobs.listJobs(pid, nid);
	const matches = jobs.filter((job) => foldCase(job.name) === foldCase(value));
	if (matches.length === 0) throw new NotFoundError(`Job '${value}' not found`);
	if (matches.length > 1)
		throw new BadRequestError(
			`Job name '${value}' is ambiguous; use one of: ${matches.map((job) => job.id).join(', ')}`,
		);
	return matches[0];
}

export function registerJobTools(
	server: McpServer,
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
): void {
	function register<Input extends z.infer<typeof NotebookSelector>>(
		name: string,
		description: string,
		inputSchema: z.ZodType<Input>,
		action: JobAction,
		handler: (input: Input, context: ToolContext) => Promise<ToolResult>,
	) {
		server.registerTool(
			name,
			{
				description,
				inputSchema,
				...(action === 'project.read' ? { annotations: { readOnlyHint: true } } : {}),
			},
			async (input, extra) => {
				const signal = request.signal
					? AbortSignal.any([extra.signal, request.signal])
					: extra.signal;
				try {
					signal.throwIfAborted();
					requireJobs(deps);
					const { project, detail } = await resolveAuthorizedNotebook(
						deps,
						principal,
						input.project,
						input.notebook,
						action,
					);
					signal.throwIfAborted();
					return await handler(input, {
						target: { project, notebook: detail, user: principal },
						extra,
						signal,
					});
				} catch (error) {
					if (signal.aborted)
						return {
							...result({
								code: 'REQUEST_CANCELLED',
								message: 'Request cancelled. Any queued job run continues.',
							}),
							isError: true,
						};
					return toolError(error, { ...request, userId: principal.id, tool: name });
				}
			},
		);
	}

	register(
		'list_jobs',
		'List a notebook’s saved jobs and schedules. Use returned IDs for running or scheduling jobs.',
		NotebookSelector.extend({
			limit: z.number().int().positive().optional(),
			cursor: z.string().optional(),
		}),
		'project.read',
		async (input, { target }) =>
			result(await listNotebookJobs(deps, target.project.id, target.notebook.meta.id, input)),
	);

	register(
		'create_job',
		'Create a saved notebook job. Omit schedule for manual-only execution; creation does not run the notebook. Parameters are strings passed as mo.cli_args(), visible to project readers; do not put secrets in them.',
		CreateJobBody.extend({ ...NotebookSelector.shape, ...IdempotencyShape }),
		'notebook.write',
		async (
			{ project: _project, notebook: _notebook, idempotency_key, ...body },
			{ target, signal },
		) => {
			const job = await idempotentOperation(
				deps,
				`${principal.id}:mcp:create_job:${target.project.id}:${target.notebook.meta.id}`,
				idempotency_key,
				async () => {
					signal.throwIfAborted();
					return toPublicJobDefinition(await createNotebookJob(deps, target, body));
				},
			);
			return result({ job });
		},
	);

	register(
		'schedule_job',
		'Change or clear a job’s cron schedule, or pause/resume it with enabled. Omitted fields stay unchanged; schedule=null makes it manual-only. Requires the job’s updated_at from list_jobs, get_notebook, or a previous mutation.',
		JobSelector.extend({
			expected_updated_at: z.iso.datetime(),
			schedule: JobScheduleShape.nullable().optional(),
			enabled: z.boolean().optional(),
		}).refine((input) => input.schedule !== undefined || input.enabled !== undefined, {
			message: 'At least one of schedule or enabled is required.',
		}),
		'notebook.write',
		async (input, { target, signal }) => {
			const job = await resolveJob(deps, target, input.job);
			return result({
				job: toPublicJobDefinition(
					await updateNotebookJob(
						deps,
						target,
						job,
						{
							schedule: input.schedule,
							enabled: input.enabled,
						},
						input.expected_updated_at,
						signal,
					),
				),
			});
		},
	);

	register(
		'run_job',
		'Enqueue a saved job for headless execution by the maintenance scheduler. Optional parameters replace the stored map for this run. Returns status and authenticated output links; poll get_job_run or wait with optional MCP progress. Tracks one attempt, not automatic retries. Reuse idempotency_key when retrying this call.',
		JobSelector.extend({ ...TriggerRunBody.shape, ...WaitShape, ...IdempotencyShape }),
		'notebook.write',
		async (input, context) => {
			const { target, signal } = context;
			const job = await resolveJob(deps, target, input.job);
			const run = await triggerJobRun(
				deps,
				target,
				job,
				{ parameters: input.parameters },
				request,
				signal,
				{
					scope: `${principal.id}:mcp:run_job:${target.project.id}:${target.notebook.meta.id}:${job.id}`,
					key: input.idempotency_key,
				},
			);
			const runId = run.run_id;
			return result(
				await observeJobRun({
					deps,
					...context,
					job,
					runId,
					input,
					request,
					action: 'notebook.write',
				}),
			);
		},
	);

	register(
		'get_job_run',
		'Read or wait for one existing job run attempt without triggering execution. Failed runs are returned as status data. Polling and waiting do not follow automatic retries or cancel the run.',
		JobSelector.extend({ run_id: z.string().regex(RunId.regex).refine(RunId.is), ...WaitShape }),
		'project.read',
		async (input, context) => {
			const job = await resolveJob(deps, context.target, input.job);
			return result(
				await observeJobRun({
					deps,
					...context,
					job,
					runId: input.run_id,
					input,
					request,
					action: 'project.read',
				}),
			);
		},
	);
}
