import type { Bucket } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { withDeadline } from '../../async';
import { Millis } from '../../duration';
import { DomainError, NotFoundError, UnavailableError } from '../../errors';
import { createSandboxId } from '../../ids';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import type {
	ComputeResources,
	ExecResult,
	SandboxInstance,
	SandboxProvider,
} from '../../ports/sandbox';
import { paths } from '../../paths';
import type { JobDefinition, JobRun, Project, RunError } from '../../schema';
import { utf8Tail } from '../../text';
import { Stopwatch } from '../../timing';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import type { NotebookDetail, NotebookService } from '../content/NotebookService';
import type { ProjectService } from '../content/ProjectService';
import { resolveBaseImage } from '../runtime/resolveBaseImage';
import { resolveComputeProfile, toComputeResourceRecord } from '../runtime/resolveComputeProfile';
import type { ResolvedComputeProfile } from '../runtime/resolveComputeProfile';
import { resolveLaunchStrategyForSession } from '../runtime/launchStrategy';
import { SandboxProvisioner } from '../runtime/SandboxProvisioner';
import type { BucketConfig, PreparedSandbox, SessionEnv } from '../runtime/SandboxProvisioner';
import { listFileSizes, readCappedFile } from '../runtime/sandboxFiles';
import { shellQuote } from '../runtime/shell';
import type { JobsService } from './JobsService';
import type { JobRunService } from './JobRunService';

/** Where the export lands inside the sandbox working dir; never persisted to the workspace. */
export const JOB_OUTPUT_FILE = '__marimo__/job_output.html';
const JOB_SESSION_FILE = '__marimo__/session/notebook.py.json';
/** Wall-clock allowance for sandbox creation + workspace copy + env setup, on top of `timeout_seconds`. */
export const JOB_PROVISION_ALLOWANCE_MS = Millis.minutes(10);
/** Tail of stdout+stderr kept on the run record's `logs.txt`. */
export const MAX_RUN_LOG_BYTES = 256 * 1024;
const EXIT_MARKER = '__MARIMOHUB_JOB_EXIT__';
const EXIT_MARKER_PATTERN = /(?:^|\n)__MARIMOHUB_JOB_EXIT__ (\d{1,3})\n?$/;
/** GNU `timeout` reports 124 when it had to stop the command. */
const TIMEOUT_EXIT_CODE = 124;
/**
 * Slack past `timeout_seconds` before the runner itself abandons the exec:
 * covers `timeout -k 30` plus the exec RPC's own deadline, so the in-process
 * bound only fires when both the sandbox and the adapter failed to stop it.
 */
const EXEC_GRACE_MS = Millis.minutes(2);
const DEFAULT_WORKDIR = '/workspace';

export interface JobRunnerSandboxConfig {
	bucket: BucketConfig;
	workdir?: string;
	startupTimeoutMs?: Millis;
	images?: string[];
	resources?: ComputeResources;
	computeProfile?: string;
	computeProfiles?: { name: string; resources: ComputeResources }[];
	computeProfileOverride?: 'none' | 'editors';
}

export interface JobRunContext {
	run: JobRun;
	job: JobDefinition;
	project: Project;
	notebook: NotebookDetail;
	/** The image and compute the run provisions with, resolved like a session start. */
	image: string | undefined;
	computeProfile: ResolvedComputeProfile;
}

export interface JobRunnerDeps {
	bucket: Bucket;
	compute: SandboxProvider;
	notebooks: NotebookService;
	projects: ProjectService;
	jobs: JobsService;
	runs: JobRunService;
	sandbox: JobRunnerSandboxConfig;
	/**
	 * Credentials + files for the sandbox: the same WIF exchange and fail-closed
	 * integration render the session create route performs, supplied by the
	 * entrypoint so this stays vendor-agnostic. Absent = nothing injected.
	 */
	resolveSessionEnv?: (context: JobRunContext) => Promise<SessionEnv | undefined>;
	provisioner?: SandboxProvisioner;
	metrics?: Metrics;
}

/**
 * Sanitize a failure into the `{ code, message }` persisted on the run — the
 * same discipline as a failed session: a DomainError's own message is ours and
 * scrubbed at the throw site; anything else only contributes its class name.
 */
export function toRunError(err: unknown): RunError {
	if (err instanceof DomainError) return { code: err.code, message: err.message };
	const e = err instanceof Error ? err : new Error(String(err));
	return { code: 'RUN_FAILED', message: `The run failed (${e.name})` };
}

function logTail(value: string, maxBytes: number): string {
	const tail = utf8Tail(value, maxBytes);
	if (tail === value) return value;
	const dropped = new TextEncoder().encode(value).byteLength - maxBytes;
	return `[… ${dropped} bytes truncated]\n${tail}`;
}

function cliArgs(parameters: JobRun['parameters']): string {
	const entries = Object.entries(parameters ?? {});
	if (entries.length === 0) return '';
	// `--` ends marimo's own options; each value is shell-quoted, never interpolated.
	return ` -- ${entries.map(([key, value]) => `--${key} ${shellQuote(value)}`).join(' ')}`;
}

/**
 * The export command wrapped for capture: the exit status is echoed on a
 * marker line because `SandboxInstance.exec` reports only success/failure. The
 * suffix match prevents notebook output from impersonating the wrapper's marker.
 */
export function jobShellCommand(
	workdir: string,
	start: string,
	timeoutSeconds: number,
	parameters: JobRun['parameters'],
): string {
	const command = `${start}${cliArgs(parameters)}`;
	const bounded = `if command -v timeout >/dev/null 2>&1; then timeout -k 30 ${timeoutSeconds} ${command}; else ${command}; fi`;
	return `cd ${shellQuote(workdir)} && rm -f ${shellQuote(JOB_OUTPUT_FILE)} && { ${bounded}; }; status=$?; printf '\\n${EXIT_MARKER} %s\\n' "$status"`;
}

export function parseExitCode(stdout: string): number | undefined {
	const match = EXIT_MARKER_PATTERN.exec(stdout);
	return match ? Number(match[1]) : undefined;
}

function stripExitMarker(stdout: string): string {
	return stdout.replace(new RegExp(`\\n?${EXIT_MARKER} \\d{1,3}\\n?$`), '');
}

class RunCancelledError extends Error {
	constructor() {
		super('run cancelled');
		this.name = 'RunCancelledError';
	}
}

class RunDeadlineError extends Error {
	constructor() {
		super('run exceeded its deadline');
		this.name = 'RunDeadlineError';
	}
}

function timeoutError(timeoutSeconds: number): RunError {
	return { code: 'RUN_TIMED_OUT', message: `The run exceeded its ${timeoutSeconds}s timeout` };
}

export interface ExportOutcome {
	event: 'succeed' | 'timeout' | 'fail';
	error?: RunError;
}

/**
 * Map what the export command reported onto the run's terminal transition.
 * marimo exits non-zero when a cell raised but still writes the HTML, so
 * success requires both a zero status and an output file.
 */
export function classifyExport(input: {
	result: ExecResult;
	exitCode: number | undefined;
	hasHtml: boolean;
	timeoutSeconds: number;
}): ExportOutcome {
	const { result, exitCode, hasHtml, timeoutSeconds } = input;
	if (result.success && exitCode === 0 && hasHtml) return { event: 'succeed' };
	const timedOut =
		exitCode === TIMEOUT_EXIT_CODE ||
		(exitCode === undefined && !result.success && /timed out/i.test(result.stderr));
	if (timedOut) return { event: 'timeout', error: timeoutError(timeoutSeconds) };
	if (exitCode !== undefined) {
		return {
			event: 'fail',
			error: {
				code: 'NOTEBOOK_FAILED',
				message: hasHtml
					? `One or more cells failed (marimo export exited with status ${exitCode})`
					: `marimo export exited with status ${exitCode} without producing output`,
			},
		};
	}
	return {
		event: 'fail',
		error: {
			code: 'RUN_FAILED',
			message: `The export command failed (${result.success ? 'no exit status' : result.error.code})`,
		},
	};
}

interface ExportCapture {
	outcome: ExportOutcome;
	exitCode: number | undefined;
	html: string | undefined;
	session: string | undefined;
	logs: string;
}

/**
 * Execute one queued run to completion: provision a copy-only sandbox with the
 * notebook's credentials, run `marimo export html` with the run's parameters,
 * capture the rendered output and logs onto the run record, and destroy the
 * sandbox on every path. Never writes to the notebook's workspace or version
 * chain — outputs live under the run prefix and only there.
 */
export class JobRunner {
	private readonly provisioner: SandboxProvisioner;
	private readonly metrics: Metrics;

	constructor(private deps: JobRunnerDeps) {
		this.provisioner = deps.provisioner ?? new SandboxProvisioner(deps.compute);
		this.metrics = deps.metrics ?? noopMetrics;
	}

	async execute(queued: JobRun): Promise<JobRun> {
		const { runs } = this.deps;
		const startedAt = Date.now();
		const fields = {
			project_id: queued.project_id,
			notebook_id: queued.notebook_id,
			job_id: queued.job_id,
			run_id: queued.run_id,
			trigger: queued.trigger,
			attempt: queued.attempt,
		};
		let context: JobRunContext;
		try {
			context = await this.loadContext(queued);
		} catch (err) {
			const { run } = await runs.transition(queued, 'fail', () => ({
				finished_at: new Date().toISOString(),
				error: toRunError(err),
			}));
			logOperationalError('job_run_context_failed', { operation: 'job.run.load', ...fields }, err);
			return run;
		}

		const sandboxId = createSandboxId();
		const provisionStartedAt = new Date();
		const deadline = new Date(
			provisionStartedAt.getTime() + queued.timeout_seconds * 1000 + JOB_PROVISION_ALLOWANCE_MS,
		).toISOString();
		const computeResources = toComputeResourceRecord(context.computeProfile.resources);
		const claimed = await runs.transition(queued, 'provision', () => ({
			sandbox_id: sandboxId,
			started_at: provisionStartedAt.toISOString(),
			deadline_at: deadline,
			...(context.image !== undefined ? { image: context.image } : {}),
			...(context.computeProfile.name !== undefined
				? { compute_profile: context.computeProfile.name }
				: {}),
			...(computeResources !== undefined ? { compute_resources: computeResources } : {}),
		}));
		// A concurrently cancelled run loses this CAS and stops here.
		if (!claimed.transitioned) return claimed.run;
		context.run = claimed.run;

		let sandbox: SandboxInstance | undefined;
		let final: JobRun = claimed.run;
		const stopwatch = new Stopwatch();
		try {
			const prepared = await this.provisioner.prepare(
				await this.provisionOptions(context, sandboxId),
			);
			sandbox = prepared.sandbox;
			Object.assign(stopwatch.timings, prepared.timings);

			const started = await runs.transition(claimed.run, 'start');
			if (!started.transitioned) throw new RunCancelledError();
			context.run = started.run;

			const { outcome, exitCode, html, session, logs } = await stopwatch.time('exec', () =>
				this.runExport(prepared, context.run),
			);
			const output = await stopwatch.time('capture', () =>
				runs.putOutputs(context.run, {
					...(html !== undefined ? { html } : {}),
					...(session !== undefined ? { session } : {}),
					logs,
				}),
			);
			final = (
				await runs.transition(context.run, outcome.event, () => ({
					finished_at: new Date().toISOString(),
					...(exitCode !== undefined ? { exit_code: exitCode } : {}),
					...(outcome.error ? { error: outcome.error } : {}),
					output,
				}))
			).run;
		} catch (err) {
			if (err instanceof RunCancelledError) {
				final = await runs
					.getRun(queued.project_id, queued.notebook_id, queued.job_id, queued.run_id)
					.catch(() => context.run);
			} else {
				const overran = err instanceof RunDeadlineError;
				if (!overran) {
					logOperationalError('job_run_failed', { operation: 'job.run.execute', ...fields }, err);
				}
				const failed = await runs
					.transition(context.run, overran ? 'timeout' : 'fail', () => ({
						finished_at: new Date().toISOString(),
						error: overran ? timeoutError(context.run.timeout_seconds) : toRunError(err),
					}))
					.catch(() => null);
				if (failed) final = failed.run;
			}
		} finally {
			// A lingering sandbox is the expensive failure — destroy on every path,
			// including the prepare failure (which already self-destroyed; idempotent).
			try {
				await (sandbox ?? this.deps.compute.create(sandboxId)).destroy();
			} catch (err) {
				logOperationalError(
					'job_sandbox_destroy_failed',
					{ operation: 'job.run.destroy', ...fields },
					err,
				);
			}
			await runs.deleteMarker(queued);
		}
		this.metrics.increment('jobs.runs.finished', 1, { status: final.status });
		logEvent({
			level: final.status === 'succeeded' ? 'info' : 'warn',
			event: 'job_run',
			...fields,
			sandbox_id: sandboxId,
			image: final.image ?? null,
			compute_profile: final.compute_profile ?? null,
			status: final.status,
			exit_code: final.exit_code ?? null,
			error_code: final.error?.code ?? null,
			duration_ms: Date.now() - startedAt,
			...Object.fromEntries(
				Object.entries(stopwatch.timings).map(([phase, ms]) => [`run_${phase}_ms`, ms]),
			),
		});
		return final;
	}

	/**
	 * Run the export and gather everything the run record needs from the
	 * sandbox: exit status, the rendered HTML and session (capped), and a log
	 * tail. The in-process deadline is the last line of defense after `timeout`
	 * in the sandbox and the exec RPC's own bound.
	 */
	private async runExport(prepared: PreparedSandbox, run: JobRun): Promise<ExportCapture> {
		const { sandbox, workdir } = prepared;
		const timeoutMs = run.timeout_seconds * 1000;
		const command = jobShellCommand(
			workdir,
			prepared.launch.start,
			run.timeout_seconds,
			run.parameters,
		);
		const result = await withDeadline(
			sandbox.exec(command, { timeout: timeoutMs + Millis.minutes(1) }),
			{ timeoutMs: timeoutMs + EXEC_GRACE_MS, timeoutError: () => new RunDeadlineError() },
		);
		const exitCode = parseExitCode(result.stdout);
		const logs = logTail(
			[stripExitMarker(result.stdout), result.stderr].filter((s) => s.trim()).join('\n'),
			MAX_RUN_LOG_BYTES,
		);
		const sizes = await listFileSizes(sandbox, `${workdir}/__marimo__`);
		const [html, session] = await Promise.all([
			readCappedFile(sandbox, `${workdir}/${JOB_OUTPUT_FILE}`, sizes),
			readCappedFile(sandbox, `${workdir}/${JOB_SESSION_FILE}`, sizes),
		]);
		const outcome = classifyExport({
			result,
			exitCode,
			hasHtml: html !== undefined,
			timeoutSeconds: run.timeout_seconds,
		});
		return { outcome, exitCode, html, session, logs };
	}

	private async loadContext(run: JobRun): Promise<JobRunContext> {
		const { jobs, notebooks, projects } = this.deps;
		const [job, project, notebook] = await Promise.all([
			jobs.getJob(run.project_id, run.notebook_id, run.job_id),
			projects.getProject(run.project_id),
			notebooks.getNotebook(run.project_id, run.notebook_id),
		]);
		if (project.status === 'deleted')
			throw new NotFoundError(`Project ${run.project_id} not found`);
		if (notebook.meta.status === 'deleted') {
			throw new NotFoundError(`Notebook ${run.notebook_id} not found`);
		}
		const { sandbox } = this.deps;
		const logFallback = (config: string) =>
			logEvent({
				level: 'error',
				event: 'stored_config_fallback',
				config,
				project_id: run.project_id,
				notebook_id: run.notebook_id,
				job_id: run.job_id,
				run_id: run.run_id,
				reason: 'selection_unavailable',
				recovered: true,
			});
		return {
			run,
			job,
			project,
			notebook,
			image: resolveBaseImage(notebook.meta.base_image, sandbox.images ?? [], () =>
				logFallback('base_image'),
			),
			// Same rule as a session start: the stored profile applies only when
			// editors may override; a removed profile falls back to the default.
			computeProfile: resolveComputeProfile(
				sandbox,
				notebook.meta.compute_profile,
				sandbox.computeProfileOverride === 'editors',
				() => logFallback('compute_profile'),
			),
		};
	}

	private async provisionOptions(
		context: JobRunContext,
		sandboxId: ReturnType<typeof createSandboxId>,
	) {
		const { bucket, sandbox } = this.deps;
		const { run, notebook } = context;
		const policy = workspaceSourcePolicy(notebook.source);
		const syncedVersionId = policy.persistSessionEdits
			? undefined
			: (run.source_version_id ?? notebook.source.current_version_id);
		if (!policy.persistSessionEdits && !syncedVersionId) {
			throw new NotFoundError('Synced notebook has not been synced yet');
		}
		const nb = paths.project(run.project_id).notebook(run.notebook_id);
		const syncedPaths = syncedVersionId ? nb.version(syncedVersionId) : undefined;
		const localVersion =
			policy.persistSessionEdits && run.source_version_id
				? nb.version(run.source_version_id)
				: undefined;
		const gitPrefix =
			notebook.source.type === 'git' && notebook.source.sync_mode === 'pull'
				? syncedPaths?.gitPrefix
				: undefined;
		const launchStrategy = await resolveLaunchStrategyForSession({
			entryNotebook: policy.entryNotebook,
			workspacePrefix: syncedPaths?.workspacePrefix,
			bucket,
		});
		// A resolver failure surfaces as the sanitized provision error, never as the
		// vendor text a credential lookup can carry. Domain errors keep their own
		// curated message.
		const sessionEnv = this.deps.resolveSessionEnv?.(context).catch((err: unknown) => {
			if (err instanceof DomainError) throw err;
			throw new UnavailableError('Failed to start sandbox while resolving credentials', {
				cause: err,
			});
		});
		void sessionEnv?.catch(() => {});
		return {
			sandboxId,
			projectId: run.project_id,
			notebookId: run.notebook_id,
			// No port is exposed for a job sandbox, so no hostname applies.
			hostname: '',
			bucket: sandbox.bucket,
			bucketHandle: bucket,
			workdir: sandbox.workdir ?? DEFAULT_WORKDIR,
			startupTimeoutMs: sandbox.startupTimeoutMs,
			image: context.image,
			resources: context.computeProfile.resources,
			sessionEnv,
			entryNotebook: policy.entryNotebook,
			launchStrategy: launchStrategy.strategy,
			launchMode: 'job' as const,
			// Never a mount: an unattended sandbox must not write through to the
			// workspace mirror, and outputs belong under the run prefix only.
			workspaceLoadMode: 'copy-only' as const,
			workspacePrefix: syncedPaths?.workspacePrefix,
			workspaceOverlay: localVersion
				? [
						{ path: 'notebook.py', key: localVersion.code },
						{ path: 'pyproject.toml', key: localVersion.deps },
					]
				: undefined,
			gitPrefix,
			workspaceArchive: syncedPaths?.workspaceArchive,
		};
	}
}
