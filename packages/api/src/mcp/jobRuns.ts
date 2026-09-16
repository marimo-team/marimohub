import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toPublicJobRun, withAbortSignal, withDeadline } from '@marimo-hub/core';
import type { JobDefinition, JobRun, RunId } from '@marimo-hub/core';
import { isTerminalRunStatus } from '@marimo-hub/core/jobs';
import type { ApiDeps } from '../context';
import { authorizeJobNotebook, loadJobRun } from '../jobs/operations';
import type { AuthorizedNotebook } from '../jobs/operations';
import { authorizationService } from '../shared';
import type { StartRequestContext } from './server';

export type JobToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const POLL_INTERVAL_SECONDS = 2;
export const WaitShape = {
	wait: z
		.boolean()
		.default(false)
		.describe('Wait for this run attempt to finish. Expiry or disconnection leaves it running.'),
	wait_seconds: z
		.number()
		.int()
		.min(1)
		.max(120)
		.default(60)
		.describe('Maximum observation time when wait is true; independent of the job timeout.'),
};
type WaitInput = z.infer<z.ZodObject<typeof WaitShape>>;
class WaitExpiredError extends Error {
	name = 'WaitExpiredError';
}

function waitForPoll(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const aborted = () => {
			clearTimeout(timer);
			reject(new DOMException('Job observation aborted', 'AbortError'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', aborted);
			resolve();
		}, POLL_INTERVAL_SECONDS * 1000);
		signal.addEventListener('abort', aborted, { once: true });
	});
}

async function waitForRun(
	initial: JobRun,
	read: (signal: AbortSignal) => Promise<JobRun>,
	input: WaitInput,
	extra: JobToolExtra,
	signal: AbortSignal,
) {
	let run = initial;
	let waitExpired = false;
	signal.throwIfAborted();
	if (!input.wait) return { run, waitExpired };
	let progress = 0;
	const token = extra._meta?.progressToken;
	try {
		await withDeadline(
			async (waitSignal) => {
				const notify = async () => {
					waitSignal.throwIfAborted();
					if (token === undefined) return;
					await withAbortSignal(
						extra.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken: token,
								progress: ++progress,
								message: `Run ${run.run_id}: ${run.status}`,
							},
						}),
						waitSignal,
					);
				};
				await notify();
				while (!isTerminalRunStatus(run.status)) {
					await waitForPoll(waitSignal);
					const next = await withAbortSignal(read(waitSignal), waitSignal);
					waitSignal.throwIfAborted();
					const changed = next.status !== run.status;
					run = next;
					if (changed) await notify();
				}
			},
			{ timeoutMs: input.wait_seconds * 1000, timeoutError: () => new WaitExpiredError(), signal },
		);
	} catch (error) {
		if (!(error instanceof WaitExpiredError)) throw error;
		waitExpired = true;
	}
	return { run, waitExpired };
}

function runResult(
	run: JobRun,
	waitExpired: boolean,
	appBaseUrl: string,
	artifacts: { html: boolean; logs: boolean },
) {
	const completed = isTerminalRunStatus(run.status);
	const base = appBaseUrl.replace(/\/$/, '');
	const notebookPath = `/projects/${run.project_id}/notebooks/${run.notebook_id}`;
	const statusUrl = `${base}/api/v1${notebookPath}/jobs/${run.job_id}/runs/${run.run_id}`;
	return {
		run: toPublicJobRun(run),
		completed,
		wait_expired: waitExpired && !completed,
		links: {
			web: `${base}${notebookPath}/jobs?job=${run.job_id}&run=${run.run_id}`,
			status: statusUrl,
			...(artifacts.html ? { html: `${statusUrl}/html` } : {}),
			...(artifacts.logs ? { logs: `${statusUrl}/logs` } : {}),
		},
		...(!completed
			? {
					poll: {
						tool: 'get_job_run',
						interval_seconds: POLL_INTERVAL_SECONDS,
						arguments: {
							project: run.project_id,
							notebook: run.notebook_id,
							job: run.job_id,
							run_id: run.run_id,
						},
					},
				}
			: {}),
	};
}

export async function observeJobRun({
	deps,
	target,
	job,
	runId,
	input,
	extra,
	signal,
	request,
	action,
}: {
	deps: ApiDeps;
	target: AuthorizedNotebook;
	job: JobDefinition;
	runId: RunId;
	input: WaitInput;
	extra: JobToolExtra;
	signal: AbortSignal;
	request: StartRequestContext;
	action: 'project.read' | 'notebook.write';
}) {
	let authorized = target;
	const authorize = async (checkSignal: AbortSignal) => {
		const current = await withAbortSignal(
			authorizeJobNotebook(deps, target.user, job.project_id, job.notebook_id, action),
			checkSignal,
		);
		await withAbortSignal(
			deps.services.jobs.getJob(job.project_id, job.notebook_id, job.id),
			checkSignal,
		);
		return current;
	};
	const initial = await withAbortSignal(loadJobRun(deps, job, runId), signal);
	const { run, waitExpired } = await waitForRun(
		initial,
		async (waitSignal) => {
			// Membership and notebook visibility can change while a call waits.
			const current = await authorize(waitSignal);
			const next = await withAbortSignal(loadJobRun(deps, job, runId), waitSignal);
			waitSignal.throwIfAborted();
			authorized = current;
			return next;
		},
		input,
		extra,
		signal,
	);
	signal.throwIfAborted();
	if (waitExpired) {
		// Expiry can occur before the next poll. Do not return data under stale access.
		authorized = await withDeadline(authorize, {
			timeoutMs: 5_000,
			timeoutError: () => new Error('Job observation authorization timed out'),
			signal,
		});
	}
	const logs =
		run.output?.logs_bytes !== undefined &&
		(
			await withAbortSignal(
				authorizationService(deps).authorize(authorized.user, 'notebook.write', {
					kind: 'project',
					project: authorized.project,
					notebookLabels: authorized.notebook.meta.security_labels ?? null,
				}),
				signal,
			)
		).allowed;
	// Zero bytes can mean either an empty HTML file or a run that only captured logs.
	const html =
		run.output !== undefined &&
		(run.output.html_bytes > 0 ||
			(await withAbortSignal(deps.services.jobRuns.readHtml(run), signal)) !== null);
	return runResult(run, waitExpired, request.appBaseUrl, { html, logs });
}
