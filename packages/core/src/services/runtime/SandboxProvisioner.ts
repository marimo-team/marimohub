import { mergeRuntimeContributions } from './runtimeContributions';
import { AGENT_CONTEXT_DIR_ENV } from './sandboxEnvironment';
import type { SessionEnv } from './sandboxEnvironment';
import { prepareMarimoPresentation } from '../marimoConfig';
export type { SessionEnv } from './sandboxEnvironment';
import type { WorkspaceLimits, WorkspaceLoadMode } from '../../integrations/remoteWorkspace';
import { allSettled } from 'better-all';
import { agentContextInstallFailureMessage, prepareAgentHomeFiles } from './agentContextFiles';
import type { Attributes, Span as OtelSpan } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { withDeadline } from '../../async';
import { ByteBudget } from './byteBudget';
import type { NotebookBridgeRuntime } from '../../ports/notebookBridge';
import { notebookBridgePaths, resolveBridgeLauncher } from './notebookBridgePaths';
import type { Bucket } from '../../ports/bucket';
import { MARIMO_PORT } from '../../constants';
import { Millis } from '../../duration';
import { PythonEnvironmentSetupError, UnavailableError } from '../../errors';
import type { NotebookId, ProjectId, SandboxId, UserId } from '../../ids';
import { effectivePersistenceMode } from './sessionPersistence';
import {
	DEFAULT_LOCAL_ENTRY_NOTEBOOK,
	workspaceSourcePolicy,
} from '../../integrations/remoteWorkspace';

import { logEvent } from '../../logs';
import { LOGGING_DIR, loggingFiles } from './logging';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type {
	ComputeResources,
	ExecResult,
	SandboxLaunchResult,
	SandboxFileWrite,
	SandboxUserHome,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
} from '../../ports/sandbox';
import { utf8Tail } from '../../text';
import { Stopwatch } from '../../timing';
import type { Timings } from '../../timing';
import { captureFilesystemSnapshot, createOrRestoreSandbox } from '../content/filesystemSnapshots';
import { buildMarimoLaunch, DEFAULT_LAUNCH_STRATEGY } from './marimoLaunch';
import type { MarimoLaunchMode, MarimoLaunchPlan, MarimoLaunchStrategyName } from './marimoLaunch';
import { assertValidKernelAuthToken, KERNEL_AUTH_TOKEN_FILE } from './kernelAuth';
import { shellQuote } from './shell';
import type { NotebookService } from '../content/NotebookService';
import {
	captureWorkspace,
	loadWorkspaceOverlay,
	readSessionArtifacts,
	restoreWorkspace,
	sharedWorkspaceListing,
} from './sandboxFiles';
import type { WorkspaceOverlay, WorkspaceRestoreStats } from './sandboxFiles';
import { restorePackedWorkspace } from './packedWorkspaceRestore';
import { sandboxWorkspaceLayout } from './workspaceLayout';
import type { SandboxWorkspaceLayout } from './workspaceLayout';

/**
 * Default wait for marimo to bind its port (override per deployment via
 * `startupTimeoutMs`, config: MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS).
 * Generous because a cold sandbox may build its uv venv from scratch (e.g. the
 * `uv-sandbox` launch strategy resolves + downloads the notebook's deps on
 * first boot). See marimoLaunch.ts.
 */
export const DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS = Millis.minutes(2);
export const SLOW_SANDBOX_SETUP_MS = Millis.seconds(2);
// Best-effort cosmetics; a hung checkout must not stall the `files` phase.
const GIT_SPARSE_CHECKOUT_TIMEOUT_MS = Millis.minutes(1);
const SETUP_OUTPUT_TAIL_BYTES = 4 * 1024;
const SETUP_MARKER = '__MARIMOHUB_SETUP__';
const SETUP_STEP_MARKER = /^__MARIMOHUB_SETUP__ step ([a-z0-9_]{1,64}) (\d{1,20})$/;
const SETUP_COMPLETE_MARKER = /^__MARIMOHUB_SETUP__ complete (\d{1,20})$/;
/**
 * Default sandbox working directory. Override per-deployment via the `workdir`
 * option (config: MARIMOHUB_COMPUTE_WORKDIR) when the sandbox image's user can't
 * write here — e.g. the marimo OSS image runs as a non-root user with no
 * `/workspace`, so writes there fail with a permission/file-IO error.
 */
const DEFAULT_WORKDIR = '/workspace';

interface SetupDiagnostics {
	failedStep?: string;
	stderr: string;
	timings: Timings;
}

function instrumentSetup(steps: readonly { name: string; command: string }[]): string {
	const commands = steps.flatMap(({ name, command }) => [
		`printf '\\n${SETUP_MARKER} step ${name} %s\\n' "$(date +%s%N)" >&2`,
		command,
	]);
	commands.push(`printf '\\n${SETUP_MARKER} complete %s\\n' "$(date +%s%N)" >&2`);
	return commands.join(' && ');
}

function parseSetupDiagnostics(stderr: string): SetupDiagnostics {
	const timings: Timings = {};
	const markers: { name: string; at: bigint }[] = [];
	const setupOutput: string[] = [];
	let inSetup = false;

	for (const line of stderr.split(/\r?\n/)) {
		const step = SETUP_STEP_MARKER.exec(line);
		if (step) {
			inSetup = true;
			markers.push({ name: step[1], at: BigInt(step[2]) });
			continue;
		}
		const complete = SETUP_COMPLETE_MARKER.exec(line);
		if (complete) {
			markers.push({ name: 'complete', at: BigInt(complete[1]) });
			inSetup = false;
			continue;
		}
		if (inSetup) setupOutput.push(line);
	}

	for (let index = 0; index + 1 < markers.length; index++) {
		const current = markers[index];
		const next = markers[index + 1];
		if (current.name === 'complete' || next.at < current.at) continue;
		timings[current.name] = Math.round(Number(next.at - current.at) / 1_000_000);
	}

	return {
		stderr: setupOutput.join('\n').trim(),
		timings,
		failedStep: inSetup ? markers.at(-1)?.name : undefined,
	};
}

function setupDiagnostics(stdout: string, stderr: string): SetupDiagnostics {
	return parseSetupDiagnostics(stderr.includes(SETUP_MARKER) ? stderr : stdout);
}

function logSlowSetup(
	options: ProvisionOptions,
	launchStrategy: MarimoLaunchStrategyName,
	setupMs: number,
	diagnostics: SetupDiagnostics,
): void {
	if (setupMs <= SLOW_SANDBOX_SETUP_MS) return;
	const timingFields = Object.fromEntries(
		Object.entries(diagnostics.timings).map(([step, ms]) => [`provision_setup_${step}_ms`, ms]),
	);
	logEvent(
		{
			level: 'warn',
			event: 'sandbox_setup_slow',
			sandbox_id: options.sandboxId,
			project_id: options.projectId,
			notebook_id: options.notebookId,
			launch_strategy: launchStrategy,
			provision_setup_ms: setupMs,
			...timingFields,
			setup_stderr_tail: utf8Tail(diagnostics.stderr, SETUP_OUTPUT_TAIL_BYTES),
		},
		{ channel: 'warn' },
	);
}

function pythonEnvironmentSetupFailure(
	result: ExecResult,
	failedStep?: string,
): PythonEnvironmentSetupError {
	if (failedStep === 'agent_context')
		return new PythonEnvironmentSetupError(agentContextInstallFailureMessage(result.stdout));
	const startupScript = /^startup_script_(\d+)$/.exec(failedStep ?? '');
	if (startupScript) {
		return new PythonEnvironmentSetupError(
			`Startup script ${startupScript[1]} failed. Check the script before restarting the workload.`,
		);
	}
	const output = `${result.stdout}\n${result.stderr}`;
	let reason = 'uv exited unsuccessfully';
	if (/permission denied/i.test(output)) {
		reason = 'the sandbox image does not allow replacing its Python environment';
	} else if (/TOMLDecodeError/i.test(output)) {
		reason = 'pyproject.toml could not be parsed';
	} else if (/No module named ['"]tomllib['"]/i.test(output)) {
		reason = 'the sandbox Python does not include the tomllib parser';
	} else if (/no (virtual environment|interpreter)|python installation not found/i.test(output)) {
		reason = 'uv could not find or create the required Python environment';
	} else if (/no solution found|resolution failed|requirements are unsatisfiable/i.test(output)) {
		reason = 'the notebook dependency constraints could not be resolved';
	}
	return new PythonEnvironmentSetupError(
		`Failed to prepare the notebook Python environment: ${reason}`,
	);
}

export interface BucketConfig {
	/** Storage bucket name, or a provider-managed bucket handle when `endpoint` is omitted. */
	name: string;
	/** S3 endpoint; optional — omit for providers that mount a bucket without one. */
	endpoint?: string;
	/** False when this storage has no sandbox-compatible mount configuration. */
	mountable?: boolean;
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	};
}

export type BootOptions = Pick<
	ProvisionOptions,
	| 'sandboxId'
	| 'projectId'
	| 'userId'
	| 'image'
	| 'resources'
	| 'userHome'
	| 'sessionIdleTimeoutMs'
	| 'restoreFilesystemSnapshotId'
>;

export interface BootedSandbox {
	sandbox: SandboxInstance;
	ready: Promise<void>;
	timings: Timings;
}

export interface WorkspacePrefetch {
	consume(
		waitUntilReady: () => Promise<void>,
		writeFiles?: SandboxInstance['writeFiles'],
	): Promise<WorkspaceLoadResult>;
	cancel(): Promise<void>;
}

export interface ProvisionOptions {
	workspaceLimits?: WorkspaceLimits;
	existingSandbox?: SandboxInstance;
	bootedSandbox?: BootedSandbox;
	workspacePrefetch?: WorkspacePrefetch;
	/** Pool assignment must succeed before any workspace or credential writes. */
	beforePrepare?: Promise<void>;
	destroyOnFailure?: boolean;
	/** Called when failure leaves no handle or sandbox destruction succeeds. */
	onSandboxDestroyed?: () => void | Promise<void>;
	sandboxId: SandboxId;
	projectId: ProjectId;
	notebookId: NotebookId;
	hostname: string;
	bucket: BucketConfig;
	/** Storage bucket handle for fallback file copy. */
	bucketHandle?: Bucket;
	/**
	 * Working directory inside the sandbox where notebook files land and marimo
	 * runs. Must be writable by the sandbox image's user. Defaults to `/workspace`.
	 */
	workdir?: string;
	/**
	 * Optional base URL marimo loads its frontend assets from (passed as
	 * `--asset-url`). Lets the kernel serve its UI from a CDN instead of bundling
	 * assets in the sandbox image — e.g.
	 * `https://cdn.jsdelivr.net/npm/@marimo-team/frontend@{version}/dist`.
	 * Config: MARIMOHUB_COMPUTE_ASSET_URL. Omit to use the image's bundled assets.
	 */
	assetUrl?: string;
	notebookBridge?: NotebookBridgeRuntime;
	bridgeParentOrigin?: string;
	/**
	 * Path prefix marimo serves under (`--base-url`), set in `proxy` exposure mode
	 * (e.g. `/proxy/<token>`) so the kernel's asset/websocket URLs resolve beneath
	 * the proxied prefix. Omit in `subdomain` mode (the kernel serves at root).
	 */
	baseUrl?: string;
	/** Partition marimo's session cookie; applied only when the kernel's browser URL is HTTPS. */
	cookiePartitioned?: boolean;
	/** Browser URL when exposure differs from the compute URL, such as Hub proxy mode. */
	publicUrl?: string;
	marimoWatch?: boolean;
	/**
	 * CoreWeave-native filesystem snapshot id to restore the sandbox FROM, when the
	 * provider supports it (see `FilesystemSnapshots`). Ignored by every other
	 * backend. The route reads it off the notebook's `fs_snapshot.json` pointer.
	 */
	restoreFilesystemSnapshotId?: string;
	/**
	 * Concrete image to boot the sandbox from (the notebook's resolved base image).
	 * Omit to use the provider's configured default. Ignored when restoring from a
	 * filesystem snapshot — the snapshot encodes its own image.
	 */
	image?: string;
	/** Backend-neutral resources resolved from the deployment's default compute profile. */
	resources?: ComputeResources;
	/** Personal directory selected for an owner-isolated editor sandbox. */
	userHome?: SandboxUserHome;
	/**
	 * The user the session is for. With `projectId` it names the sandbox's owner
	 * to adapters that partition compute per tenant.
	 */
	userId?: UserId;
	/** Control-plane idle deadline used by providers to derive an orphan backstop. */
	sessionIdleTimeoutMs?: Millis;
	/**
	 * Environment variables and files to inject before dependency setup. Never logged.
	 * Promises let credential resolution overlap sandbox boot. The caller resolves credentials.
	 */
	sessionEnv?: SessionEnv | Promise<SessionEnv | undefined>;
	/** Interactive marimo credential. Scheduled-job preparation omits it. */
	kernelAuthToken?: string;
	/** Known content joins pre-launch file writes; otherwise published after exposure resolves. */
	contextFile?: { path: string; content?: string };
	/** Workspace-relative notebook file marimo should open. Defaults to `notebook.py`. */
	entryNotebook?: string;
	/**
	 * Source launch strategy. Resolution overlaps sandbox boot.
	 * Defaults to the project-managed environment.
	 */
	launchStrategy?: MarimoLaunchStrategyName | Promise<MarimoLaunchStrategyName>;
	/**
	 * How long Python-environment setup and the kernel-port wait may take in total
	 * before failing the provision. Defaults to `DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS`.
	 */
	startupTimeoutMs?: Millis;
	/**
	 * Launch mode driving the marimo subcommand (see `LAUNCH_MODES`). `app` and
	 * `job` sandboxes must also pass `workspaceLoadMode: 'copy-only'` — a mounted
	 * workspace would let notebook code write through to the bucket.
	 */
	launchMode?: MarimoLaunchMode;
	/** How to load the cached workspace into the sandbox. Defaults to mount-or-copy. */
	workspaceLoadMode?: WorkspaceLoadMode;
	/**
	 * Bucket prefix to load the workspace from. Defaults to the notebook's mutable
	 * `workspace/` mirror; synced sources pass their current immutable
	 * `versions/{vid}/workspace/` prefix instead.
	 */
	workspacePrefix?: string;
	/** Overrides workspace files. Object restores include these files in the first batch. */
	workspaceOverlay?: WorkspaceOverlay;
	/** Pull-source Git metadata restored into `<workdir>/.git`. */
	gitPrefix?: string;
	/**
	 * Subtree of the repository a pull source mirrors. The workspace and kernel
	 * then live at `<workdir>/<gitRootPath>` under a sparse checkout while
	 * `.git` stays at `<workdir>`, where its repository-relative index resolves.
	 * Ignored without `gitPrefix`.
	 */
	gitRootPath?: string;
	/** Optional packed copy of a synced workspace and its Git metadata. */
	workspaceArchive?: string;
}

/**
 * A sandbox after the prepare phases (reachable → workspace → inject → setup)
 * and before any kernel starts: what a headless job needs, since it runs the
 * launch plan's command itself and exposes no port.
 */
export interface PreparedSandbox {
	sandbox: SandboxInstance;
	/** The resolved launch plan; `launch.start` is the command to run in `workdir`. */
	launch: MarimoLaunchPlan;
	workdir: string;
	usedFallback: boolean;
	timings: Timings;
	counters: Record<string, number>;
}

export interface ProvisionResult {
	sandbox: SandboxInstance;
	url: string;
	/** Whether files were loaded via manual copy (true) or bucket mount (false) */
	usedFallback: boolean;
	/** Wall-clock total and per-phase ms: handle, reachable, files, inject, setup, start, waitport, expose. */
	timings: Timings;
	/**
	 * Non-duration measurements for the same wide event — workspace objects/bytes
	 * copied, command round-trips. Kept apart from `timings` so nothing here gets
	 * reported as milliseconds.
	 */
	counters: Record<string, number>;
}

interface MarimoStartup {
	onSetup?: (output: { stdout: string; stderr: string }, elapsed: number) => void;
	plan: MarimoLaunchPlan;
	deadline: {
		startedAt: number;
		timeoutMs: number;
	};
}

type SandboxLaunchFailure = Extract<SandboxLaunchResult, { success: false }>;

async function readWorkspacePythonPath(
	sandbox: SandboxInstance,
	mountPath: string,
	timeoutMs: number,
): Promise<string> {
	const result = await sandbox.exec('printf \'%s\' "${PYTHONPATH-}"', {
		timeout: timeoutMs,
		maxOutputBytes: 64 * 1024,
	});
	if (!result.success || new TextEncoder().encode(result.stdout).byteLength >= 64 * 1024)
		throw new Error('Could not read the sandbox Python path');
	const root = sandbox.resolveProcessPath?.(mountPath) ?? mountPath;
	if (result.stdout === root || result.stdout.startsWith(`${root}:`)) return result.stdout;
	return result.stdout ? `${root}:${result.stdout}` : root;
}

function remainingStartupMs(startup: MarimoStartup): number {
	const { startedAt, timeoutMs } = startup.deadline;
	return timeoutMs === 0 ? 0 : Math.max(0, timeoutMs - (Date.now() - startedAt));
}

function pythonEnvironmentSetupTimeout(timeoutMs: number): PythonEnvironmentSetupError {
	return new PythonEnvironmentSetupError(
		`Failed to prepare the notebook Python environment within the ${Math.round(timeoutMs / 1000)}s startup timeout (MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS)`,
	);
}

function kernelReadinessTimeoutStep(timeoutMs: number): string {
	return `starting the marimo kernel: not ready within the ${Math.round(timeoutMs / 1000)}s startup timeout (MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS)`;
}

function formatKernelLogs(stdout: string, stderr: string): string {
	return [stdout, stderr]
		.filter((value) => value.trim())
		.join('\n')
		.replaceAll(/([?&]access_token=)[A-Za-z0-9_-]+/g, '$1[REDACTED]')
		.trim();
}

/**
 * Wrap a low-level compute/SDK failure in an UnavailableError (→ HTTP 503) with a
 * message that is informative but safe to show a client: the step that failed plus
 * the error class and any vendor status code (duck-typed, no SDK import). Secrets
 * (credentials, bucket contents, request bodies) are never part of these fields.
 * The full error — stack, cause, transport metadata — is preserved as `cause` for
 * the server-side structured log.
 */
function provisionFailure(step: string, err: unknown): UnavailableError {
	const e = err as { name?: string; code?: string; transportCode?: string };
	const parts = [`Failed to start sandbox while ${step}`];
	if (e?.name) parts.push(e.name);
	// gRPC status (e.g. INTERNAL, UNAVAILABLE) or SDK code — operational, not sensitive.
	const code = e?.transportCode ?? e?.code;
	if (code) parts.push(`[${code}]`);
	// The vendor message is deliberately dropped: an SDK can echo the request it
	// failed on, credentials included, and this string is shown to the caller and
	// persisted on the session record.
	return new UnavailableError(parts.join(' '), { cause: err });
}

function supervisedLaunchFailure(result: SandboxLaunchFailure, timeoutMs: number): Error {
	if (result.reason === 'setup_timeout') return pythonEnvironmentSetupTimeout(timeoutMs);
	if (result.reason === 'setup_exit') {
		return pythonEnvironmentSetupFailure(
			{
				success: false,
				stdout: result.stdout,
				stderr: result.stderr,
				error: { code: 'COMMAND_FAILED' },
			},
			setupDiagnostics(result.stdout, result.stderr).failedStep,
		);
	}
	const step =
		result.reason === 'readiness_timeout'
			? kernelReadinessTimeoutStep(timeoutMs)
			: 'starting the marimo kernel';
	const logs = formatKernelLogs(result.stdout, result.stderr);
	return provisionFailure(
		logs ? `${step}; kernel output:\n${logs}` : step,
		new Error(result.reason),
	);
}

async function readKernelLogs(process: SandboxProcess | undefined): Promise<string> {
	if (!process) return '';
	try {
		const { stdout, stderr } = await process.getLogs();
		return formatKernelLogs(stdout, stderr);
	} catch {
		// The process or sandbox may already be gone.
		return '';
	}
}

function adapterAttributedKernelCrash(error: unknown): boolean {
	// Only the first line is adapter attribution; later lines may contain echoed kernel output.
	const attribution = error instanceof Error ? error.message.split('\n', 1)[0] : '';
	return /before port \d+/.test(attribution);
}

function kernelLaunchFailureStep(
	error: unknown,
	startup: MarimoStartup,
	portWaitStarted: boolean,
): string {
	const { startedAt, timeoutMs } = startup.deadline;
	const timedOut =
		portWaitStarted && !adapterAttributedKernelCrash(error) && Date.now() - startedAt >= timeoutMs;
	return timedOut ? kernelReadinessTimeoutStep(timeoutMs) : 'starting the marimo kernel';
}

function executeEnvironmentSetup(
	sandbox: SandboxInstance,
	command: string,
	startup: MarimoStartup,
): Promise<ExecResult> {
	const timeoutMs = remainingStartupMs(startup);
	const pending = sandbox.exec(command, { timeout: timeoutMs });
	if (startup.deadline.timeoutMs === 0) return pending;
	return withDeadline(pending, {
		timeoutMs,
		timeoutError: () => pythonEnvironmentSetupTimeout(startup.deadline.timeoutMs),
	});
}

/**
 * On scope exit, fold any timings the adapter recorded internally into `sw` under
 * `<phase>_`. CoreWeave resolves its sandbox lazily, so its create/find ms would
 * otherwise be invisible — buried inside whichever span triggered the first call.
 */
function drainTimingsInto(
	sandbox: SandboxInstance,
	sw: Stopwatch,
	phase: string,
	span?: OtelSpan,
): Disposable {
	return {
		[Symbol.dispose]() {
			for (const [name, ms] of Object.entries(sandbox.drainTimings?.() ?? {})) {
				sw.timings[`${phase}_${name}`] = ms;
				span?.setAttribute(`${name}_ms`, ms);
			}
		},
	};
}

type TimeSandboxPhase = <T>(fn: () => Promise<T>) => Promise<T>;

async function withSandboxSpan<T>(
	sw: Stopwatch,
	name: string,
	fn: (time: TimeSandboxPhase, span: OtelSpan) => Promise<T>,
	attributes?: Attributes,
): Promise<T> {
	const time: TimeSandboxPhase = (fn) => sw.time(name, fn);
	return trace
		.getTracer('@marimo-hub/core')
		.startActiveSpan(`sandbox.${name}`, { attributes }, async (span) => {
			try {
				return await fn(time, span);
			} catch (error) {
				span.recordException(error instanceof Error ? error : String(error));
				span.setStatus({ code: SpanStatusCode.ERROR });
				throw error;
			} finally {
				span.end();
			}
		});
}

export interface WorkspaceLoadContext {
	writeFiles?: SandboxInstance['writeFiles'];
	workspaceLimits?: WorkspaceLimits;
	overlay?: WorkspaceOverlay;
	sandbox: SandboxInstance;
	projectId: ProjectId;
	notebookId: NotebookId;
	bucket: BucketConfig;
	bucketHandle?: Bucket;
	mountPath: string;
	workspacePrefix: string;
	excludeRelativeRoots?: readonly string[];
	waitUntilReady?: () => Promise<void>;
	prefetchBudget?: ByteBudget;
}

export interface WorkspaceLoadResult {
	/** Files were copied in (true) rather than bucket-mounted (false). */
	usedFallback: boolean;
	/** True when this load applies ctx.overlay. Otherwise the provisioner applies it afterward. */
	overlayApplied?: boolean;
	/** What the copy moved; absent when the workspace was mounted instead. */
	stats?: WorkspaceRestoreStats;
	archiveStatus?: 'used' | 'missing' | 'failed';
	archiveBytes?: number;
}

export interface WorkspaceLoadStrategy {
	/** Must await ctx.waitUntilReady before sandbox operations when enabled. */
	readonly supportsPrefetch?: boolean;
	load(ctx: WorkspaceLoadContext): Promise<WorkspaceLoadResult>;
}

export interface WorkspaceLoadStrategies {
	copyOnly: WorkspaceLoadStrategy;
	mountOrCopy: WorkspaceLoadStrategy;
}

class CopyWorkspaceLoadStrategy implements WorkspaceLoadStrategy {
	readonly supportsPrefetch = true;

	async load({
		sandbox,
		bucketHandle,
		workspacePrefix,
		mountPath,
		excludeRelativeRoots,
		waitUntilReady,
		prefetchBudget,
		overlay,
		workspaceLimits,
		writeFiles,
	}: WorkspaceLoadContext): Promise<WorkspaceLoadResult> {
		if (!bucketHandle) {
			throw provisionFailure(
				'restoring the notebook workspace into the sandbox',
				new Error('bucket handle is required for copy-only workspace loading'),
			);
		}
		try {
			const stats = await restoreWorkspace(sandbox, bucketHandle, workspacePrefix, mountPath, {
				limits: workspaceLimits,
				writeFiles,
				// Capture treats absent files as deletions, so a session must restore every file.
				requireComplete: true,
				overlay,
				excludeRelativeRoots,
				waitUntilReady,
				prefetchBudget,
			});
			return { usedFallback: true, overlayApplied: true, stats };
		} catch (err) {
			throw provisionFailure('restoring the notebook workspace into the sandbox', err);
		}
	}
}

class MountOrCopyWorkspaceLoadStrategy implements WorkspaceLoadStrategy {
	readonly supportsPrefetch = true;

	constructor(private copyFallback: WorkspaceLoadStrategy) {}

	async load(ctx: WorkspaceLoadContext): Promise<WorkspaceLoadResult> {
		if (ctx.bucket.mountable === false || ctx.sandbox.supportsBucketMount === false) {
			return this.copyFallback.load(ctx);
		}
		await ctx.waitUntilReady?.();
		try {
			await ctx.sandbox.mountBucket({
				bucketName: ctx.bucket.name,
				endpoint: ctx.bucket.endpoint,
				mountPath: ctx.mountPath,
				prefix: ctx.workspacePrefix,
				credentials: ctx.bucket.credentials,
			});
			return { usedFallback: false };
		} catch (err) {
			if (ctx.sandbox.supportsBucketMount) {
				throw provisionFailure('mounting the notebook workspace into the sandbox', err);
			}
			if (!ctx.bucketHandle) {
				throw provisionFailure('mounting the notebook workspace into the sandbox', err);
			}
			return this.copyFallback.load(ctx);
		}
	}
}

export function createWorkspaceLoadStrategies(): WorkspaceLoadStrategies {
	const copyOnly = new CopyWorkspaceLoadStrategy();
	return { copyOnly, mountOrCopy: new MountOrCopyWorkspaceLoadStrategy(copyOnly) };
}

function loadCounters(load: WorkspaceLoadResult): Record<string, number> {
	const counters: Record<string, number> = {};
	if (load.stats) {
		counters.files_objects = load.stats.objectCount;
		counters.files_bytes = load.stats.bytes;
	}
	if (load.archiveStatus) {
		counters.files_archive_used = load.archiveStatus === 'used' ? 1 : 0;
		counters.files_archive_missing = load.archiveStatus === 'missing' ? 1 : 0;
		counters.files_archive_failed = load.archiveStatus === 'failed' ? 1 : 0;
		if (load.archiveBytes !== undefined) counters.files_archive_bytes = load.archiveBytes;
	}
	return counters;
}

function workspaceLocation(options: ProvisionOptions) {
	return {
		layout: sandboxWorkspaceLayout(
			options.workdir ?? DEFAULT_WORKDIR,
			options.gitPrefix ? (options.gitRootPath ?? '') : '',
		),
		prefix:
			options.workspacePrefix ??
			paths.project(options.projectId).notebook(options.notebookId).workspacePrefix,
	};
}

function normalizeAbsoluteSandboxPath(value: string): string {
	if (!value.startsWith('/')) return value;
	const segments: string[] = [];
	for (const segment of value.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`;
}

async function writeSessionFiles(
	writeFiles: SandboxInstance['writeFiles'],
	files: NonNullable<SessionEnv['files']>,
	kernelAuthToken?: string,
): Promise<void> {
	if (kernelAuthToken !== undefined) assertValidKernelAuthToken(kernelAuthToken);
	if (
		kernelAuthToken !== undefined &&
		files.some(({ path }) => normalizeAbsoluteSandboxPath(path) === KERNEL_AUTH_TOKEN_FILE)
	) {
		throw new Error(`Session credentials cannot write reserved path ${KERNEL_AUTH_TOKEN_FILE}`);
	}
	const batch = [...files];
	if (kernelAuthToken !== undefined)
		batch.push({ path: KERNEL_AUTH_TOKEN_FILE, content: kernelAuthToken });
	if (batch.length > 0) await writeFiles(batch);
}

/**
 * Share the budget across requests for reads ahead of readiness or the current
 * write batch. Restores fall back to serial reads when the budget is exhausted.
 */
const DEFAULT_PREFETCH_BUDGET = new ByteBudget(64 * 1024 * 1024);

export class SandboxProvisioner {
	private readonly prefetchBudget: ByteBudget;

	constructor(
		private provider: SandboxProvider,
		private workspaceLoadStrategies: WorkspaceLoadStrategies = createWorkspaceLoadStrategies(),
		options: { prefetchBudget?: ByteBudget } = {},
	) {
		this.prefetchBudget = options.prefetchBudget ?? DEFAULT_PREFETCH_BUDGET;
	}

	boot(options: BootOptions): BootedSandbox {
		const started = Date.now();
		const sandbox = this.createSandbox(options);
		const sw = new Stopwatch();
		sw.timings.handle = Date.now() - started;
		const ready = this.ensureReachable(sandbox, sw).finally(() => {
			sw.timings.boot_overlap = Date.now() - started;
		});
		ready.catch(() => {});
		return { sandbox, ready, timings: sw.timings };
	}

	prefetchWorkspace(sandbox: SandboxInstance, options: ProvisionOptions): WorkspacePrefetch {
		const gate = Promise.withResolvers<SandboxInstance['writeFiles']>();
		gate.promise.catch(() => {});
		const { layout, prefix } = workspaceLocation(options);
		const loaded = this.loadWorkspace(
			sandbox,
			options,
			layout,
			prefix,
			async () => {
				await gate.promise;
			},
			async (files) => (await gate.promise)(files),
		);
		loaded.catch(() => {});
		return {
			consume(waitUntilReady, writeFiles = sandbox.writeFiles.bind(sandbox)) {
				gate.resolve(waitUntilReady().then(() => writeFiles));
				return loaded;
			},
			async cancel() {
				gate.reject(new Error('Workspace prefetch cancelled'));
				await loaded.catch(() => {});
			},
		};
	}

	async provision(options: ProvisionOptions): Promise<ProvisionResult> {
		const provisionStart = Date.now();
		options.beforePrepare?.catch(() => {});
		// A restored sandbox boots from the snapshot image; the workspace load below
		// still refreshes the code from the bucket cache.
		const createStart = Date.now();
		let sandbox: SandboxInstance | undefined;
		try {
			sandbox =
				options.bootedSandbox?.sandbox ?? options.existingSandbox ?? this.createSandbox(options);
			if (options.existingSandbox && !options.bootedSandbox) {
				// Claim-time probes belong to warm-pool telemetry, not provisioning.
				sandbox.drainTimings?.();
				sandbox.drainCounters?.();
			}
			const createMs = Date.now() - createStart;
			const result = await this.provisionInto(sandbox, options);
			// Backend creation is timed during readiness, not handle construction.
			result.timings.handle = options.bootedSandbox?.timings.handle ?? createMs;
			result.timings.total = Date.now() - provisionStart;
			return result;
		} catch (err) {
			// The caller retains cleanup ownership for a supplied sandbox.
			if ((options.existingSandbox || options.bootedSandbox) && !options.destroyOnFailure)
				throw err;
			// The saga does not compensate the step that throws. A failed handle
			// constructor leaves nothing to destroy but still needs a cleanup marker.
			await this.reclaimAfterFailure(sandbox, options);
			throw err;
		}
	}

	/** Prepare a headless workload without starting or exposing a kernel. */
	async prepare(options: ProvisionOptions): Promise<PreparedSandbox> {
		const prepareStart = Date.now();
		const createStart = Date.now();
		let sandbox: SandboxInstance | undefined;
		try {
			sandbox = this.createSandbox(options);
			const createMs = Date.now() - createStart;
			const { load, startup, sw, mountPath } = await this.prepareInto(sandbox, options);
			const counters = loadCounters(load);
			Object.assign(counters, sandbox.drainCounters?.() ?? {});
			Object.assign(sw.timings, sandbox.drainTimings?.() ?? {});
			sw.timings.handle = createMs;
			sw.timings.total = Date.now() - prepareStart;
			return {
				sandbox,
				launch: startup.plan,
				workdir: mountPath,
				usedFallback: load.usedFallback,
				timings: sw.timings,
				counters,
			};
		} catch (err) {
			await this.reclaimAfterFailure(sandbox, options);
			throw err;
		}
	}

	private createSandbox(options: BootOptions): SandboxInstance {
		return createOrRestoreSandbox(
			this.provider,
			options.sandboxId,
			options.restoreFilesystemSnapshotId,
			{
				image: options.image,
				resources: options.resources,
				userHome: options.userHome,
				sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
				owner: {
					projectId: options.projectId,
					...(options.userId ? { userId: options.userId } : {}),
				},
			},
		);
	}

	private async reclaimAfterFailure(
		sandbox: SandboxInstance | undefined,
		options: ProvisionOptions,
	): Promise<void> {
		try {
			await sandbox?.destroy();
			await options.onSandboxDestroyed?.();
		} catch {
			// Cleanup must not replace the provisioning error.
		}
	}

	private async provisionInto(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
	): Promise<ProvisionResult> {
		const { load, startup, sw, mountPath, exposedUrl } = await this.prepareInto(
			sandbox,
			options,
			true,
		);
		await this.launchKernel(sandbox, mountPath, sw, startup);
		const expose = await this.exposeKernel(sandbox, options, sw);
		if (exposedUrl && new URL(expose).origin !== new URL(exposedUrl).origin) {
			throw provisionFailure(
				'exposing the kernel port',
				new Error('Sandbox origin changed after launch'),
			);
		}

		const counters = loadCounters(load);
		// Last: the adapter's command count is only final once every phase has run.
		Object.assign(counters, sandbox.drainCounters?.() ?? {});
		Object.assign(sw.timings, sandbox.drainTimings?.() ?? {});

		return { sandbox, url: expose, usedFallback: load.usedFallback, timings: sw.timings, counters };
	}

	private async prepareInto(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		launch = false,
	): Promise<{
		load: WorkspaceLoadResult;
		startup: MarimoStartup;
		sw: Stopwatch;
		mountPath: string;
		exposedUrl?: string;
	}> {
		const launchStrategy = Promise.resolve(options.launchStrategy ?? DEFAULT_LAUNCH_STRATEGY);
		launchStrategy.catch(() => {});
		const { layout, prefix } = workspaceLocation(options);
		const mountPath = layout.workdir;
		const sw = new Stopwatch();
		const combineWrites = Boolean(sandbox.supportsLaunchSetupOutput);
		const deferSetup =
			launch && Boolean(sandbox.launchProcess && sandbox.supportsLaunchSetupOutput);
		const extraFiles: SandboxFileWrite[] = [];
		const bridgeFiles: SandboxFileWrite[] = [];
		let bridgeUnavailable = false;
		const setupPrefix: MarimoLaunchPlan['setup'] = [];
		const installers: (() => Promise<void>)[] = [];
		let extrasReady = false;
		const writeFiles = sandbox.writeFiles.bind(sandbox);
		const stageFiles: SandboxInstance['writeFiles'] = combineWrites
			? async (files) => {
					extraFiles.push(...files);
				}
			: writeFiles;
		const stageBridge: SandboxInstance['writeFiles'] = combineWrites
			? async (files) => {
					bridgeFiles.push(...files);
				}
			: writeFiles;
		let sharedWrite: Promise<void> | undefined;
		const flush = async (files: readonly SandboxFileWrite[]) => {
			// Slow credential resolution must not hold up an otherwise-ready workspace transfer.
			if (!extrasReady) {
				if (files.length > 0) await writeFiles(files);
				return;
			}
			if (sharedWrite) {
				await sharedWrite;
				if (files.length > 0) await sandbox.writeFiles(files);
				return;
			}
			const batch = [
				...new Map([...files, ...extraFiles].map((file) => [file.path, file])).values(),
			];
			sharedWrite = (async () => {
				if (batch.length === 0 && bridgeFiles.length === 0) return;
				try {
					await sandbox.writeFiles([...batch, ...bridgeFiles]);
				} catch (error) {
					if (bridgeFiles.length === 0) throw error;
					if (batch.length > 0) await writeFiles(batch);
					bridgeUnavailable = true;
					logEvent(
						{
							level: 'warn',
							event: 'notebook_bridge_unavailable',
							reason: 'prepare_failed',
							sandbox_id: options.sandboxId,
						},
						{ channel: 'warn' },
					);
				}
			})();
			const started = Date.now();
			try {
				await sharedWrite;
			} catch (error) {
				sharedWrite = undefined;
				throw error;
			}
			extraFiles.length = 0;
			bridgeFiles.length = 0;
			// Credential and bridge timings overlap; files overlaps only when this flush includes workspace files.
			sw.timings.inject_files = Date.now() - started;
			if (options.notebookBridge) sw.timings.bridge_prepare = sw.timings.inject_files;
		};
		const workspaceWriter = combineWrites && !options.gitPrefix ? flush : undefined;

		const ensureReachable = async () => {
			if (options.bootedSandbox) {
				await options.bootedSandbox.ready;
				Object.assign(sw.timings, options.bootedSandbox.timings);
			} else await this.ensureReachable(sandbox, sw);
			await options.beforePrepare;
		};
		// Git and workspace restores may wait concurrently; record one shared readiness wait.
		let workspaceReadiness: Promise<void> | undefined;
		const loadWorkspace = (waitUntilReady: () => Promise<void>) =>
			withSandboxSpan(sw, 'files', async (time, span) => {
				const loaded = await time(async () => {
					const loaded = await (options.workspacePrefetch?.consume(
						waitUntilReady,
						workspaceWriter,
					) ??
						this.loadWorkspace(sandbox, options, layout, prefix, waitUntilReady, workspaceWriter));
					if (!loaded.overlayApplied) {
						await this.applyWorkspaceOverlay(sandbox, options, mountPath);
					}
					return loaded;
				});
				sw.timings.files_non_waiting = Math.max(
					0,
					sw.timings.files - (sw.timings.files_waitready ?? 0),
				);
				span.setAttributes({
					readiness_wait_ms: sw.timings.files_waitready ?? 0,
					non_waiting_ms: sw.timings.files_non_waiting,
					objects: loaded.stats?.objectCount ?? 0,
					bytes: loaded.stats?.bytes ?? 0,
					used_fallback: loaded.usedFallback,
				});
				return loaded;
			});
		const injectSessionEnv = () =>
			withSandboxSpan(sw, 'inject', async (time, span) => {
				await this.injectSessionEnv(sandbox, options, time, mountPath, sw, {
					writeFiles: stageFiles,
					deferInstall: combineWrites,
					setupPrefix,
					installers,
					deferSetup,
				});
				span.setAttributes({
					files_ms: sw.timings.inject_files ?? 0,
					environment_ms: sw.timings.inject_env ?? 0,
				});
			});
		let pythonPath: Promise<string> | undefined;
		const setupEnvironment = async (
			bridgeLauncher: string | undefined,
			publicUrl: string | undefined,
		) =>
			this.setupEnvironment(sandbox, options, mountPath, sw, await launchStrategy, {
				bridgeLauncher: bridgeUnavailable ? undefined : bridgeLauncher,
				publicUrl,
				pythonPath,
				deferSetup,
				setupPrefix,
			});
		const uploadBridge = () =>
			launchStrategy.then(
				(strategy) => this.uploadNotebookBridge(sandbox, options, sw, strategy, stageBridge),
				// Setup reports strategy failures after workspace loading and injection finish.
				(): undefined => {},
			);

		const exposeKernel = () => this.exposeKernel(sandbox, options, sw, 'prepare_exposure');
		// Settle every writer before the caller can reclaim the sandbox.
		const prepared = await allSettled<{
			reachable: () => Promise<void>;
			load: () => Promise<WorkspaceLoadResult>;
			inject: () => Promise<void>;
			bridge: () => Promise<string | undefined>;
			upload: () => Promise<void>;
			exposure: () => Promise<string | undefined>;
			setup: () => Promise<MarimoStartup>;
		}>({
			async reachable(): Promise<void> {
				await ensureReachable();
			},
			async load(): Promise<WorkspaceLoadResult> {
				try {
					return await loadWorkspace(
						() => (workspaceReadiness ??= sw.time('files_waitready', () => this.$.reachable)),
					);
				} finally {
					await this.$.reachable;
				}
			},
			async inject(): Promise<void> {
				await this.$.reachable;
				await injectSessionEnv();
				if (options.entryNotebook?.includes('/')) {
					// Reading the inherited path overlaps the workspace restore instead of delaying
					// setup; setup bounds the wait and reports failures. The startup clock has not
					// started yet, so the whole budget is the tightest bound for the exec.
					const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS;
					pythonPath = readWorkspacePythonPath(
						sandbox,
						mountPath,
						startupTimeoutMs === 0 ? 10_000 : Math.min(10_000, startupTimeoutMs),
					);
					// Setup may fail before awaiting this read.
					pythonPath.catch(() => {});
				}
			},
			async bridge(): Promise<string | undefined> {
				await this.$.reachable;
				return uploadBridge();
			},
			async exposure(): Promise<string | undefined> {
				await this.$.reachable;
				if (!launch) return;
				const reserved = await sandbox.prepareExposure?.(MARIMO_PORT, {
					hostname: options.hostname,
					token: options.sandboxId,
				});
				if (reserved) return reserved.url;
				if (!options.publicUrl) {
					await this.$.upload;
					return exposeKernel();
				}
			},
			async upload(): Promise<void> {
				await this.$.inject;
				await this.$.bridge;
				extrasReady = true;
				await this.$.load;
				if (combineWrites) await flush([]);
				for (const install of installers) await install();
			},
			async setup(): Promise<MarimoStartup> {
				await this.$.upload;
				// Waiting for the bridge upload lets setup write the final environment file, which
				// the launch command then reuses instead of rewriting it.
				const exposedUrl = await this.$.exposure;
				return setupEnvironment(await this.$.bridge, options.publicUrl ?? exposedUrl);
			},
		});
		if (prepared.reachable.status === 'rejected') throw prepared.reachable.reason;
		if (prepared.load.status === 'rejected') throw prepared.load.reason;
		if (prepared.inject.status === 'rejected') throw prepared.inject.reason;
		if (prepared.bridge.status === 'rejected') throw prepared.bridge.reason;
		if (prepared.upload.status === 'rejected')
			throw provisionFailure('injecting session credentials', prepared.upload.reason);
		if (prepared.exposure.status === 'rejected')
			throw provisionFailure('exposing the kernel port', prepared.exposure.reason);
		if (prepared.setup.status === 'rejected') throw prepared.setup.reason;
		return {
			load: prepared.load.value,
			startup: prepared.setup.value,
			sw,
			mountPath,
			exposedUrl: prepared.exposure.value,
		};
	}

	private async uploadNotebookBridge(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		sw: Stopwatch,
		launchStrategy: MarimoLaunchStrategyName,
		writeFiles = sandbox.writeFiles.bind(sandbox),
	): Promise<string | undefined> {
		const payload = options.notebookBridge;
		if (
			!payload ||
			!options.bridgeParentOrigin ||
			options.launchMode === 'job' ||
			launchStrategy === 'uv-sandbox'
		)
			return;
		const { directory } = notebookBridgePaths(options.sandboxId, payload.launcher);
		try {
			await withSandboxSpan(sw, 'bridge_prepare', (time) =>
				time(() =>
					withDeadline(
						writeFiles(
							payload.files.map(({ name, content }) => ({ path: `${directory}/${name}`, content })),
						),
						{
							timeoutMs: Math.min(10_000, options.startupTimeoutMs || 10_000),
							timeoutError: () => new Error('Bridge preparation timed out'),
						},
					),
				),
			);
			return resolveBridgeLauncher(sandbox, {
				sandboxId: options.sandboxId,
				launcher: payload.launcher,
			});
		} catch {
			logEvent(
				{
					level: 'warn',
					event: 'notebook_bridge_unavailable',
					reason: 'prepare_failed',
					sandbox_id: options.sandboxId,
				},
				{ channel: 'warn' },
			);
			return;
		}
	}

	private async configureNotebookBridge(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		startup: MarimoStartup,
		launcher: string,
	): Promise<void> {
		if (!options.bridgeParentOrigin) return;
		try {
			const budget = startup.deadline.timeoutMs === 0 ? 10_000 : remainingStartupMs(startup);
			if (budget <= 0) return;
			await withDeadline(
				sandbox.setEnvVars({
					MARIMOHUB_BRIDGE_PARENT_ORIGIN: options.bridgeParentOrigin,
					MARIMOHUB_BRIDGE_INSTALL_TIMEOUT_MS: String(Math.min(10_000, budget)),
					...(startup.deadline.timeoutMs > 0
						? {
								MARIMOHUB_BRIDGE_STARTUP_DEADLINE_MS: String(
									startup.deadline.startedAt + startup.deadline.timeoutMs,
								),
							}
						: {}),
				}),
				{
					timeoutMs: Math.min(10_000, budget),
					timeoutError: () => new Error('Bridge configuration timed out'),
				},
			);
			startup.plan.start = startup.plan.start.replace(
				/(?:python -m )?marimo --quiet /,
				`python ${shellQuote(launcher)} --quiet `,
			);
		} catch {
			logEvent(
				{
					level: 'warn',
					event: 'notebook_bridge_unavailable',
					reason: 'prepare_failed',
					sandbox_id: options.sandboxId,
				},
				{ channel: 'warn' },
			);
		}
	}

	private async applyWorkspaceOverlay(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
	): Promise<void> {
		const overlay = options.workspaceOverlay;
		if (!overlay || overlay.length === 0) return;
		const bucket = options.bucketHandle;
		if (!bucket) throw new UnavailableError('Bucket access is required for workspace overlay');
		try {
			await sandbox.writeFiles(await loadWorkspaceOverlay(bucket, mountPath, overlay));
		} catch (err) {
			throw provisionFailure('restoring the notebook workspace into the sandbox', err);
		}
	}

	private async ensureReachable(sandbox: SandboxInstance, sw: Stopwatch): Promise<void> {
		await withSandboxSpan(sw, 'reachable', async (time, span) => {
			using _drained = drainTimingsInto(sandbox, sw, 'reachable', span);
			try {
				// Adapters without `ready()` fall back to a no-op command, which proves the
				// same thing at the cost of a round-trip.
				await time(async () => {
					await (sandbox.ready?.() ?? sandbox.exec('true'));
				});
			} catch (err) {
				throw new UnavailableError('Sandbox compute backend is not available', { cause: err });
			}
		});
	}

	private async loadWorkspace(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		layout: SandboxWorkspaceLayout,
		workspacePrefix: string,
		waitUntilReady: () => Promise<void>,
		writeFiles?: SandboxInstance['writeFiles'],
	): Promise<WorkspaceLoadResult> {
		// Only a possible mount needs the integration result. Copy prefetch still overlaps resolution.
		let workspaceOptions = options;
		if (
			options.workspaceLoadMode !== 'copy-only' &&
			sandbox.supportsBucketMount !== false &&
			options.bucket.mountable !== false &&
			options.sessionEnv
		) {
			// A failed boot must not wait for pending credential resolution.
			const sessionEnv = await Promise.race([
				options.sessionEnv,
				waitUntilReady().then(() => options.sessionEnv),
			]);
			if (sessionEnv?.workspaceLoadMode === 'copy-only') {
				workspaceOptions = { ...options, workspaceLoadMode: 'copy-only' };
			}
		}
		const loaded = await this.restoreWorkspaceFiles(
			sandbox,
			workspaceOptions,
			layout,
			workspacePrefix,
			waitUntilReady,
			writeFiles,
		);
		await waitUntilReady();
		return loaded;
	}

	private async restoreWorkspaceFiles(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		layout: SandboxWorkspaceLayout,
		workspacePrefix: string,
		waitUntilReady: () => Promise<void>,
		writeFiles?: SandboxInstance['writeFiles'],
	): Promise<WorkspaceLoadResult> {
		if (
			options.workspaceLoadMode === 'copy-only' &&
			options.workspaceArchive &&
			options.bucketHandle
		) {
			const packed = await restorePackedWorkspace(
				sandbox,
				options.bucketHandle,
				options.workspaceArchive,
				layout.gitRoot,
				Boolean(options.gitPrefix),
				layout.rootPath,
				waitUntilReady,
				this.prefetchBudget,
			);
			if (packed.status === 'restored') {
				return {
					usedFallback: true,
					stats: { objectCount: 1, bytes: packed.archiveBytes },
					archiveStatus: 'used',
					archiveBytes: packed.archiveBytes,
				};
			}
			if (packed.status === 'failed') {
				logOperationalError(
					'packed_workspace_restore_failed',
					{
						operation: 'session.workspace_archive.restore',
						object: options.workspaceArchive,
						project_id: options.projectId,
						notebook_id: options.notebookId,
						recovered: true,
					},
					packed.error,
				);
			}
			const fallback = await this.loadWorkspaceObjects(
				sandbox,
				options,
				layout,
				workspacePrefix,
				waitUntilReady,
				writeFiles,
			);
			return {
				...fallback,
				archiveStatus: packed.status === 'missing' ? 'missing' : 'failed',
			};
		}
		return this.loadWorkspaceObjects(
			sandbox,
			options,
			layout,
			workspacePrefix,
			waitUntilReady,
			writeFiles,
		);
	}

	private gitWorkdirCommand(layout: SandboxWorkspaceLayout): string {
		// Restored `.git` may have a different owner; sparse checkout keeps subtree status clean.
		const commands = [
			'if command -v git >/dev/null 2>&1; then',
			`git config --global --add safe.directory ${shellQuote(layout.gitRoot)}`,
		];
		if (layout.rootPath) {
			commands.push(
				`cd ${shellQuote(layout.gitRoot)} && git -c ${shellQuote(`safe.directory=${layout.gitRoot}`)} sparse-checkout set --cone -- ${shellQuote(layout.rootPath)}`,
			);
		}
		commands.push('fi');
		return commands.join('\n');
	}

	private async configureGitWorkdir(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		layout: SandboxWorkspaceLayout,
	): Promise<void> {
		const result = await sandbox.exec(this.gitWorkdirCommand(layout), {
			timeout: GIT_SPARSE_CHECKOUT_TIMEOUT_MS,
		});
		if (result.success || !layout.rootPath) return;
		logOperationalError(
			'git_sparse_checkout_failed',
			{
				operation: 'session.git.sparse_checkout',
				object: layout.workdir,
				project_id: options.projectId,
				notebook_id: options.notebookId,
				recovered: true,
			},
			new Error(result.stderr.trim().slice(-500) || 'git sparse-checkout failed'),
		);
	}

	private async loadWorkspaceObjects(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		layout: SandboxWorkspaceLayout,
		workspacePrefix: string,
		waitUntilReady: () => Promise<void>,
		writeFiles?: SandboxInstance['writeFiles'],
	): Promise<WorkspaceLoadResult> {
		const mountPath = layout.workdir;
		const strategy =
			options.workspaceLoadMode === 'copy-only'
				? this.workspaceLoadStrategies.copyOnly
				: this.workspaceLoadStrategies.mountOrCopy;
		if (!strategy.supportsPrefetch) await waitUntilReady();
		const load = strategy.load({
			writeFiles,
			overlay: options.workspaceOverlay,
			workspaceLimits: options.workspaceLimits,
			sandbox,
			projectId: options.projectId,
			notebookId: options.notebookId,
			bucket: options.bucket,
			bucketHandle: options.bucketHandle,
			mountPath,
			workspacePrefix,
			waitUntilReady,
			prefetchBudget: this.prefetchBudget,
			...(options.gitPrefix ? { excludeRelativeRoots: ['.git'] } : {}),
		});
		if (!options.gitPrefix) return load;
		const gitPrefix = options.gitPrefix;
		const restoreGit = async (): Promise<WorkspaceRestoreStats> => {
			try {
				if (!options.bucketHandle) {
					throw new Error('bucket handle is required for Git metadata restoration');
				}
				const stats = await restoreWorkspace(
					sandbox,
					options.bucketHandle,
					gitPrefix,
					`${layout.gitRoot}/.git`,
					{
						requireComplete: true,
						limits: options.workspaceLimits,
						excludeRelativeRoots: ['hooks'],
						waitUntilReady,
						prefetchBudget: this.prefetchBudget,
					},
				);
				if (stats.objectCount === 0) throw new Error('the stored Git directory is empty');
				return stats;
			} catch (error) {
				logOperationalError(
					'git_workspace_restore_failed',
					{
						operation: 'session.git.restore',
						object: gitPrefix,
						project_id: options.projectId,
						notebook_id: options.notebookId,
					},
					error,
				);
				throw provisionFailure('restoring Git metadata into the sandbox', error);
			}
		};
		const copyPath =
			options.workspaceLoadMode === 'copy-only' || sandbox.supportsBucketMount === false;
		const restore = await allSettled<{
			load: () => Promise<WorkspaceLoadResult>;
			git: () => Promise<WorkspaceRestoreStats>;
		}>({
			load: () => load,
			async git(): Promise<WorkspaceRestoreStats> {
				if (!copyPath) await this.$.load;
				return restoreGit();
			},
		});
		if (restore.load.status === 'rejected') throw restore.load.reason;
		if (restore.git.status === 'rejected') throw restore.git.reason;
		const loaded = restore.load.value;
		const gitStats = restore.git.value;
		if (!loaded.stats) return { ...loaded, stats: gitStats };
		return {
			...loaded,
			stats: {
				objectCount: loaded.stats.objectCount + gitStats.objectCount,
				bytes: loaded.stats.bytes + gitStats.bytes,
			},
		};
	}

	private async injectSessionEnv(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		time: TimeSandboxPhase,
		workdir: string,
		sw: Stopwatch,
		batch: {
			writeFiles: SandboxInstance['writeFiles'];
			deferInstall: boolean;
			setupPrefix: MarimoLaunchPlan['setup'];
			installers: (() => Promise<void>)[];
			deferSetup: boolean;
		},
	): Promise<void> {
		const resolvedEnv = await options.sessionEnv;
		const kernelAuthToken = options.kernelAuthToken;
		if (
			!resolvedEnv &&
			kernelAuthToken === undefined &&
			!options.contextFile &&
			!options.restoreFilesystemSnapshotId
		)
			return;
		await time(async () => {
			try {
				const sessionEnv = prepareMarimoPresentation(
					resolvedEnv,
					(path) => sandbox.resolveProcessPath?.(path) ?? path,
					{ restored: options.restoreFilesystemSnapshotId !== undefined, mode: options.launchMode },
				);
				const files = [...(sessionEnv?.files ?? [])];
				if (resolvedEnv?.logging?.length) {
					files.push(
						...loggingFiles(resolvedEnv.logging, {
							sandboxId: options.sandboxId,
							notebookId: options.notebookId,
							mode: options.launchMode ?? 'edit',
						}),
					);
				}
				if (options.contextFile?.content !== undefined) {
					files.push({ path: options.contextFile.path, content: options.contextFile.content });
				}
				const vars = { ...sessionEnv?.vars };
				if (options.restoreFilesystemSnapshotId && vars[AGENT_CONTEXT_DIR_ENV] === undefined) {
					vars[AGENT_CONTEXT_DIR_ENV] = '';
				}
				if (options.contextFile) {
					vars.MARIMOHUB_CONTEXT_FILE =
						sandbox.resolveProcessPath?.(options.contextFile.path) ?? options.contextFile.path;
				}
				const defaults = sessionEnv?.defaults;
				const writeFiles = async () => {
					if (
						!options.restoreFilesystemSnapshotId &&
						normalizeAbsoluteSandboxPath(workdir) !== '/' &&
						!files.some((file) => file.relativeTo === 'home')
					)
						return writeSessionFiles(batch.writeFiles, files, kernelAuthToken);
					const prepared = await prepareAgentHomeFiles(
						sandbox,
						files,
						normalizeAbsoluteSandboxPath(workdir),
						options.restoreFilesystemSnapshotId !== undefined,
					);
					if (batch.deferSetup && prepared.input && prepared.command) {
						const path =
							prepared.payloadPath ?? `/tmp/.marimohub-agent-context-${crypto.randomUUID()}.json`;
						if (!prepared.payloadPath) await batch.writeFiles([{ path, content: prepared.input }]);
						const processPath = shellQuote(sandbox.resolveProcessPath?.(path) ?? path);
						batch.setupPrefix.push({
							name: 'agent_context',
							command: `(${prepared.command} < ${processPath}; status=$?; rm -f ${processPath}; exit "$status")`,
						});
					} else if (prepared.install && batch.deferInstall)
						batch.installers.push(prepared.install);
					await writeSessionFiles(batch.writeFiles, prepared.files, kernelAuthToken);
					if (!batch.deferInstall) await prepared.install?.();
				};
				await Promise.all([
					sw.time('inject_files', writeFiles),
					sw.time('inject_env', async () => {
						await Promise.all([
							Object.keys(vars).length > 0 ? sandbox.setEnvVars(vars) : undefined,
							defaults && Object.keys(defaults).length > 0
								? sandbox.setEnvVars(defaults, { onlyIfUnset: true })
								: undefined,
						]);
					}),
				]);
			} catch (err) {
				throw provisionFailure('injecting session credentials', err);
			}
		});
	}

	private async configureWorkspacePythonPath(
		sandbox: SandboxInstance,
		pythonPath: Promise<string>,
		startup: MarimoStartup,
	): Promise<void> {
		const timeoutMs =
			startup.deadline.timeoutMs === 0 ? 10_000 : Math.min(10_000, remainingStartupMs(startup));
		if (timeoutMs <= 0) throw pythonEnvironmentSetupTimeout(startup.deadline.timeoutMs);
		try {
			await withDeadline(
				(async () => {
					await sandbox.setEnvVars({ PYTHONPATH: await pythonPath });
				})(),
				{
					timeoutMs,
					timeoutError: () => new Error('Python path configuration timed out'),
				},
			);
		} catch (error) {
			throw provisionFailure('configuring the workspace Python path', error);
		}
	}

	private async setupEnvironment(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		sw: Stopwatch,
		launchStrategy: MarimoLaunchStrategyName,
		prepared: {
			bridgeLauncher?: string;
			publicUrl?: string;
			pythonPath?: Promise<string>;
			deferSetup?: boolean;
			setupPrefix?: MarimoLaunchPlan['setup'];
		},
	): Promise<MarimoStartup> {
		const sessionEnv = await options.sessionEnv;
		const loggingPath = sessionEnv?.logging?.length ? LOGGING_DIR : undefined;
		const publicUrl = prepared.publicUrl === undefined ? undefined : new URL(prepared.publicUrl);
		if (publicUrl && !['http:', 'https:'].includes(publicUrl.protocol)) {
			throw provisionFailure(
				'configuring the kernel origin',
				new Error('Sandbox URL must use HTTP or HTTPS'),
			);
		}
		const startup: MarimoStartup = {
			plan: buildMarimoLaunch(
				{
					notebookFile: options.entryNotebook ?? DEFAULT_LOCAL_ENTRY_NOTEBOOK,
					port: MARIMO_PORT,
					host: '0.0.0.0',
					mode: options.launchMode,
					assetUrl: options.assetUrl,
					baseUrl: options.baseUrl,
					cookiePartitioned: options.cookiePartitioned && publicUrl?.protocol === 'https:',
					allowedOrigin: publicUrl?.origin,
					tokenPasswordFile:
						options.kernelAuthToken !== undefined ? KERNEL_AUTH_TOKEN_FILE : undefined,
					watch: options.marimoWatch,
					...mergeRuntimeContributions(sessionEnv),
					loggingDirectory: loggingPath
						? (sandbox.resolveProcessPath?.(loggingPath) ?? loggingPath)
						: undefined,
				},
				launchStrategy,
			),
			deadline: {
				startedAt: Date.now(),
				timeoutMs: options.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
			},
		};
		// Environment changes must land before the first setup or launch command so that every
		// command shares one environment file.
		if (prepared.bridgeLauncher) {
			await this.configureNotebookBridge(sandbox, options, startup, prepared.bridgeLauncher);
		}
		const { pythonPath } = prepared;
		if (pythonPath) {
			// marimo adds the entry's directory; other workspace tools also need the shared root.
			await withSandboxSpan(sw, 'pythonpath', (time) =>
				time(() => this.configureWorkspacePythonPath(sandbox, pythonPath, startup)),
			);
		}
		if (options.gitPrefix) {
			const { layout } = workspaceLocation(options);
			if (prepared.deferSetup)
				startup.plan.setup.unshift({
					name: 'git_config',
					command: `(${this.gitWorkdirCommand(layout)}) || true`,
				});
			else await this.configureGitWorkdir(sandbox, options, layout);
		}
		startup.plan.setup.unshift(...(prepared.setupPrefix ?? []));
		if (prepared.deferSetup) {
			startup.onSetup = (output, elapsed) => {
				const diagnostics = setupDiagnostics(output.stdout, output.stderr);
				for (const [step, ms] of Object.entries(diagnostics.timings))
					sw.timings[`setup_${step}`] = ms;
				logSlowSetup(options, launchStrategy, elapsed, diagnostics);
			};
			return startup;
		}
		if (startup.plan.setup.length === 0) return startup;

		const command = `cd ${shellQuote(mountPath)} && ${instrumentSetup(startup.plan.setup)}`;
		let diagnostics: SetupDiagnostics | undefined;
		try {
			await withSandboxSpan(
				sw,
				'setup',
				async (time) => {
					const result = await time(() => executeEnvironmentSetup(sandbox, command, startup));
					diagnostics = setupDiagnostics(result.stdout, result.stderr);
					for (const [step, ms] of Object.entries(diagnostics.timings)) {
						sw.timings[`setup_${step}`] = ms;
					}
					if (!result.success) throw pythonEnvironmentSetupFailure(result, diagnostics.failedStep);
				},
				{ launch_strategy: launchStrategy },
			);
		} catch (error) {
			if (error instanceof PythonEnvironmentSetupError) throw error;
			throw provisionFailure('preparing the notebook Python environment', error);
		} finally {
			if (diagnostics) logSlowSetup(options, launchStrategy, sw.timings.setup, diagnostics);
		}
		return startup;
	}

	private async launchKernel(
		sandbox: SandboxInstance,
		mountPath: string,
		sw: Stopwatch,
		startup: MarimoStartup,
	): Promise<void> {
		const launchProcess = sandbox.launchProcess?.bind(sandbox);
		if (launchProcess) {
			await this.launchSupervisedKernel(launchProcess, mountPath, sw, startup);
			return;
		}
		await this.launchKernelProcess(sandbox, mountPath, sw, startup);
	}

	private async launchSupervisedKernel(
		launchProcess: NonNullable<SandboxInstance['launchProcess']>,
		mountPath: string,
		sw: Stopwatch,
		startup: MarimoStartup,
	): Promise<void> {
		const timeoutMs = remainingStartupMs(startup);
		if (startup.deadline.timeoutMs !== 0 && timeoutMs === 0) {
			throw provisionFailure(
				kernelReadinessTimeoutStep(startup.deadline.timeoutMs),
				new Error('readiness_timeout'),
			);
		}

		let result: SandboxLaunchResult;
		try {
			result = await launchProcess(startup.plan.start, {
				cwd: mountPath,
				...(startup.onSetup ? { setup: instrumentSetup(startup.plan.setup) } : {}),
				port: MARIMO_PORT,
				waitForPort: { mode: 'tcp' },
				startupTimeout: timeoutMs,
			});
		} catch (error) {
			throw provisionFailure('starting the marimo kernel', error);
		}
		if (startup.onSetup) {
			const output = result.success ? result.setupOutput : result;
			if (output === undefined) {
				throw provisionFailure(
					'collecting setup output',
					new Error('Adapter with supportsLaunchSetupOutput omitted setupOutput'),
				);
			}
			sw.timings.setup = result.timings.setup;
			startup.onSetup(output, result.timings.setup);
		}
		sw.timings.start = result.timings.start;
		sw.timings.waitport = result.timings.waitport;
		if (!result.success) throw supervisedLaunchFailure(result, startup.deadline.timeoutMs);
	}

	private async launchKernelProcess(
		sandbox: SandboxInstance,
		mountPath: string,
		sw: Stopwatch,
		startup: MarimoStartup,
	): Promise<void> {
		let process: SandboxProcess | undefined;
		let portWaitStarted = false;
		try {
			const proc = await withSandboxSpan(sw, 'start', (time) =>
				time(() => sandbox.startProcess(startup.plan.start, { cwd: mountPath })),
			);
			process = proc;
			portWaitStarted = true;
			await withSandboxSpan(sw, 'waitport', (time) =>
				time(() => proc.waitForPort(MARIMO_PORT, { timeout: remainingStartupMs(startup) })),
			);
		} catch (error) {
			const logs = await readKernelLogs(process);
			const step = kernelLaunchFailureStep(error, startup, portWaitStarted);
			throw provisionFailure(logs ? `${step}; kernel output:\n${logs}` : step, error);
		}
	}

	private async exposeKernel(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		sw: Stopwatch,
		phase = 'expose',
	): Promise<string> {
		try {
			const { url } = await withSandboxSpan(sw, phase, (time) =>
				time(() =>
					sandbox.exposePort(MARIMO_PORT, {
						hostname: options.hostname,
						token: options.sandboxId,
					}),
				),
			);
			return url;
		} catch (err) {
			throw provisionFailure('exposing the kernel port', err);
		}
	}

	/**
	 * Save a live session's notebook back to the bucket WITHOUT tearing it down —
	 * the periodic-snapshot primitive, and the save half of `teardown`. Reads the
	 * session artifacts back, cuts a version via `commitSession` (which dedupes
	 * unchanged content, so an idle notebook never accretes spurious versions), and
	 * — unless `includeWorkspace` is false — mirrors the runtime workspace per
	 * `persistWorkspace`. The periodic snapshotter passes `includeWorkspace: false`:
	 * a full workspace re-upload every interval is too expensive, so the mirror is
	 * only refreshed at teardown, as before.
	 *
	 * Returns false when the session is ephemeral (`persistEdits: false` — a
	 * viewer's throwaway sandbox) or the notebook's source is remote/git-backed
	 * (owned by its sync path — session edits are never persisted). Throws when
	 * the source policy cannot be read (committing without it could clobber a
	 * synced source), or when
	 * a save step fails; a commit failure does not skip the workspace capture
	 * (matching the old teardown's independent best-effort steps).
	 */
	async captureSession(
		sandbox: SandboxInstance,
		notebooks: NotebookService,
		bucket: Bucket,
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		persistWorkspace: 'source' | 'workspace',
		workdir: string = DEFAULT_WORKDIR,
		opts?: { includeWorkspace?: boolean; persistEdits?: boolean },
	): Promise<boolean> {
		if (opts?.persistEdits === false) return false;
		const { source } = await notebooks.getNotebook(projectId, notebookId);
		const policy = workspaceSourcePolicy(source);
		const captureMode = effectivePersistenceMode({ persistEdits: true, source, persistWorkspace });
		if (captureMode === 'none') return false;

		const mountPath = workdir;
		const listing = sharedWorkspaceListing(sandbox, mountPath);
		// The commit chain and the workspace mirror are independent best-effort
		// steps over disjoint bucket keys, so they run concurrently.
		const { commit, workspace } = await allSettled({
			async commit() {
				const artifacts = await readSessionArtifacts(
					sandbox,
					mountPath,
					listing,
					policy.entryNotebook,
				);
				await notebooks.commitSession(projectId, notebookId, artifacts, actor);
			},
			async workspace() {
				if (opts?.includeWorkspace === false) return;
				await captureWorkspace(
					sandbox,
					bucket,
					projectId,
					notebookId,
					mountPath,
					captureMode,
					listing,
					policy.entryNotebook,
					notebooks.workspace.limits,
				);
			},
		});
		const commitError =
			commit.status === 'rejected'
				? commit.reason instanceof Error
					? commit.reason
					: new Error(String(commit.reason))
				: undefined;
		if (workspace.status === 'rejected') {
			// A workspace failure would otherwise mask the commit failure — surface both.
			if (commitError) {
				logOperationalError(
					'session_commit_failed',
					{ operation: 'sandbox.commit_session', notebook_id: notebookId },
					commitError,
				);
			}
			throw workspace.reason;
		}
		if (commitError) throw commitError;
		return true;
	}

	/**
	 * Tear down a session: read the notebook back, cut a version carrying the
	 * session's edits and any HTML/session snapshots marimo produced, capture the
	 * runtime workspace, capture a filesystem snapshot (when the backend supports
	 * it), then destroy the sandbox.
	 *
	 * The read-back is unconditional for local notebooks: interactive edits still
	 * need an immutable version, even when the sandbox wrote through a mounted
	 * bucket. `NotebookService.commitSession` owns the source files
	 * (the entry notebook and `workspace/pyproject.toml`) and the immutable
	 * `versions/{vid}/` record; `captureWorkspace` excludes those, so there is no
	 * double-write. All capture steps are best-effort — failures are logged but
	 * never block sandbox destruction, since a lingering sandbox is the more
	 * expensive failure.
	 *
	 * `persistWorkspace` controls runtime-file persistence: `source` captures only
	 * the source files (via `commitSession`); `workspace` also mirrors the rest of
	 * the working dir into `workspace/`.
	 */
	async teardown(
		sandbox: SandboxInstance,
		notebooks: NotebookService,
		bucket: Bucket,
		projectId: ProjectId,
		notebookId: NotebookId,
		actor: UserId,
		persistWorkspace: 'source' | 'workspace',
		workdir: string = DEFAULT_WORKDIR,
		opts?: {
			persistEdits?: boolean;
			computeProfile?: string;
			computeResources?: { cpu?: number; memory_bytes?: number };
		},
	): Promise<void> {
		// `captureSession` owns the persistence checks: false = an ephemeral session
		// or a synced/remote source, whose edits (and filesystem snapshot) are never
		// persisted from a session — destroy only.
		// Failed captures must not replace the last good restore snapshot.
		let persisted = false;
		try {
			persisted = await this.captureSession(
				sandbox,
				notebooks,
				bucket,
				projectId,
				notebookId,
				actor,
				persistWorkspace,
				workdir,
				{ persistEdits: opts?.persistEdits },
			);
		} catch (err) {
			// Non-fatal: still destroy the sandbox so it does not linger and bill.
			logOperationalError(
				'session_capture_failed',
				{ operation: 'sandbox.teardown.capture_session', notebook_id: notebookId },
				err,
			);
		}
		if (persisted) {
			// Snapshot before destroy, once the session state above is final. Both are
			// sandbox RPCs: a transient gRPC stream reset here must not reject teardown,
			// and destroy must run regardless so the sandbox cannot linger and bill.
			try {
				await captureFilesystemSnapshot(this.provider, notebooks, sandbox, projectId, notebookId, {
					compute_profile: opts?.computeProfile,
					compute_resources: opts?.computeResources,
					owner_user_id: actor,
				});
			} catch (err) {
				logOperationalError(
					'filesystem_snapshot_capture_failed',
					{ operation: 'sandbox.teardown.capture_snapshot', notebook_id: notebookId },
					err,
				);
			}
		}
		try {
			await sandbox.destroy();
		} catch (err) {
			logOperationalError(
				'sandbox_destroy_failed',
				{ operation: 'sandbox.teardown.destroy', notebook_id: notebookId },
				err,
			);
		}
	}
}
