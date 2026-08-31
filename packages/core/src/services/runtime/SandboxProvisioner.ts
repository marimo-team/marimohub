import { all, allSettled } from 'better-all';
import type { Attributes, Span as OtelSpan } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { withDeadline } from '../../async';
import type { Bucket } from '../../ports/bucket';
import { MARIMO_PORT } from '../../constants';
import type { SessionMode } from '../../constants';
import { Millis } from '../../duration';
import { PythonEnvironmentSetupError, UnavailableError } from '../../errors';
import type { NotebookId, ProjectId, SandboxId, UserId } from '../../ids';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import type { WorkspaceLoadMode } from '../../integrations/remoteWorkspace';
import { logEvent } from '../../logs';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type {
	ComputeResources,
	ExecResult,
	SandboxLaunchResult,
	SandboxUserHome,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
} from '../../ports/sandbox';
import { Stopwatch } from '../../timing';
import type { Timings } from '../../timing';
import { captureFilesystemSnapshot, createOrRestoreSandbox } from '../content/filesystemSnapshots';
import { buildMarimoLaunch, DEFAULT_LAUNCH_STRATEGY } from './marimoLaunch';
import type { MarimoLaunchPlan, MarimoLaunchStrategyName } from './marimoLaunch';
import { shellQuote } from './shell';
import type { NotebookService } from '../content/NotebookService';
import { captureWorkspace, readSessionArtifacts, restoreWorkspace } from './sandboxFiles';
import type { WorkspaceRestoreStats } from './sandboxFiles';
import { restorePackedWorkspace } from './packedWorkspaceRestore';

/**
 * Default wait for marimo to bind its port (override per deployment via
 * `startupTimeoutMs`, config: MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS).
 * Generous because a cold sandbox may build its uv venv from scratch (e.g. the
 * `uv-sandbox` launch strategy resolves + downloads the notebook's deps on
 * first boot). See marimoLaunch.ts.
 */
export const DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS = Millis.minutes(2);
export const SLOW_SANDBOX_SETUP_MS = Millis.seconds(2);
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

	return { stderr: setupOutput.join('\n').trim(), timings };
}

function setupDiagnostics(stdout: string, stderr: string): SetupDiagnostics {
	return parseSetupDiagnostics(stderr.includes(SETUP_MARKER) ? stderr : stdout);
}

function utf8Tail(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let start = encoded.byteLength - maxBytes;
	while ((encoded[start] & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(encoded.slice(start));
}

function logSlowSetup(
	options: ProvisionOptions,
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
			launch_strategy: options.launchStrategy ?? DEFAULT_LAUNCH_STRATEGY,
			provision_setup_ms: setupMs,
			...timingFields,
			setup_stderr_tail: utf8Tail(diagnostics.stderr, SETUP_OUTPUT_TAIL_BYTES),
		},
		{ channel: 'warn' },
	);
}

function pythonEnvironmentSetupFailure(result: ExecResult): PythonEnvironmentSetupError {
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

/** Env vars + files injected into a sandbox before the kernel starts. */
export interface SessionEnv {
	vars?: Record<string, string>;
	/**
	 * Fallback vars, applied with `onlyIfUnset`: the sandbox image's own value
	 * wins when it defines one. Use `vars` for anything policy- or
	 * credential-bearing — a default the image can shadow is not a control.
	 */
	defaults?: Record<string, string>;
	files?: { path: string; content: string }[];
}

export interface ProvisionOptions {
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
	/**
	 * Path prefix marimo serves under (`--base-url`), set in `proxy` exposure mode
	 * (e.g. `/proxy/<token>`) so the kernel's asset/websocket URLs resolve beneath
	 * the proxied prefix. Omit in `subdomain` mode (the kernel serves at root).
	 */
	baseUrl?: string;
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
	 * Environment + files to inject into the sandbox BEFORE the kernel starts — the
	 * assembled output of the workload-identity broker (federated S3 creds) and/or
	 * the secrets provider. The provisioner stays vendor-agnostic: it only sets env
	 * + writes files; it never mints tokens or reads secrets. Never logged.
	 *
	 * Accepts a promise: it is awaited only at the inject phase, so the caller's
	 * credential resolution overlaps the (dominant) sandbox create.
	 */
	sessionEnv?: SessionEnv | Promise<SessionEnv | undefined>;
	/** Workspace-relative notebook file marimo should open. Defaults to `notebook.py`. */
	entryNotebook?: string;
	/** Per-source launch strategy (see launchStrategy.ts). Defaults to the project-managed env. */
	launchStrategy?: MarimoLaunchStrategyName;
	/**
	 * How long Python-environment setup and the kernel-port wait may take in total
	 * before failing the provision. Defaults to `DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS`.
	 */
	startupTimeoutMs?: Millis;
	/**
	 * Session mode driving the marimo subcommand (see `LAUNCH_MODES`). `app`
	 * sandboxes must also pass `workspaceLoadMode: 'copy-only'` — a mounted
	 * workspace would let app code write through to the bucket.
	 */
	launchMode?: SessionMode;
	/** How to load the cached workspace into the sandbox. Defaults to mount-or-copy. */
	workspaceLoadMode?: WorkspaceLoadMode;
	/**
	 * Bucket prefix to load the workspace from. Defaults to the notebook's mutable
	 * `workspace/` mirror; synced sources pass their current immutable
	 * `versions/{vid}/workspace/` prefix instead.
	 */
	workspacePrefix?: string;
	/** Pull-source Git metadata restored into `<workdir>/.git`. */
	gitPrefix?: string;
	/** Optional packed copy of a synced workspace and its Git metadata. */
	workspaceArchive?: string;
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
	plan: MarimoLaunchPlan;
	deadline: {
		startedAt: number;
		timeoutMs: number;
	};
}

type SandboxLaunchFailure = Extract<SandboxLaunchResult, { success: false }>;

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
		return pythonEnvironmentSetupFailure({
			success: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: { code: 'COMMAND_FAILED' },
		});
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
	sandbox: SandboxInstance;
	projectId: ProjectId;
	notebookId: NotebookId;
	bucket: BucketConfig;
	bucketHandle?: Bucket;
	mountPath: string;
	workspacePrefix: string;
	excludeRelativeRoots?: readonly string[];
}

export interface WorkspaceLoadResult {
	/** Files were copied in (true) rather than bucket-mounted (false). */
	usedFallback: boolean;
	/** What the copy moved; absent when the workspace was mounted instead. */
	stats?: WorkspaceRestoreStats;
	archiveStatus?: 'used' | 'missing' | 'failed';
	archiveBytes?: number;
}

export interface WorkspaceLoadStrategy {
	load(ctx: WorkspaceLoadContext): Promise<WorkspaceLoadResult>;
}

export interface WorkspaceLoadStrategies {
	copyOnly: WorkspaceLoadStrategy;
	mountOrCopy: WorkspaceLoadStrategy;
}

class CopyWorkspaceLoadStrategy implements WorkspaceLoadStrategy {
	async load({
		sandbox,
		bucketHandle,
		workspacePrefix,
		mountPath,
		excludeRelativeRoots,
	}: WorkspaceLoadContext): Promise<WorkspaceLoadResult> {
		if (!bucketHandle) {
			throw provisionFailure(
				'restoring the notebook workspace into the sandbox',
				new Error('bucket handle is required for copy-only workspace loading'),
			);
		}
		try {
			const stats = await restoreWorkspace(
				sandbox,
				bucketHandle,
				workspacePrefix,
				mountPath,
				excludeRelativeRoots ? { excludeRelativeRoots } : undefined,
			);
			return { usedFallback: true, stats };
		} catch (err) {
			throw provisionFailure('restoring the notebook workspace into the sandbox', err);
		}
	}
}

class MountOrCopyWorkspaceLoadStrategy implements WorkspaceLoadStrategy {
	constructor(private copyFallback: WorkspaceLoadStrategy) {}

	async load(ctx: WorkspaceLoadContext): Promise<WorkspaceLoadResult> {
		if (ctx.bucket.mountable === false || ctx.sandbox.supportsBucketMount === false) {
			return this.copyFallback.load(ctx);
		}
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

export class SandboxProvisioner {
	constructor(
		private provider: SandboxProvider,
		private workspaceLoadStrategies: WorkspaceLoadStrategies = createWorkspaceLoadStrategies(),
	) {}

	async provision(options: ProvisionOptions): Promise<ProvisionResult> {
		const provisionStart = Date.now();
		// A restored sandbox boots from the snapshot image; the workspace load below
		// still refreshes the code from the bucket cache.
		const createStart = Date.now();
		const sandbox = createOrRestoreSandbox(
			this.provider,
			options.sandboxId,
			options.restoreFilesystemSnapshotId,
			options.image,
			options.resources,
			options.userHome,
		);
		const createMs = Date.now() - createStart;
		try {
			const result = await this.provisionInto(sandbox, options);
			// Constructing the (usually lazy) handle, NOT the backend's create — that
			// lands in `reachable_create` once the adapter resolves it.
			result.timings.handle = createMs;
			result.timings.total = Date.now() - provisionStart;
			return result;
		} catch (err) {
			// Provisioning failed partway — destroy any partial sandbox before
			// rethrowing so a half-started kernel/mount doesn't linger and bill. The
			// caller's saga never compensates the step that threw, so cleanup of the
			// resource this method created is this method's responsibility.
			try {
				await sandbox.destroy();
			} catch {
				// Best-effort: the sandbox may not have been created.
			}
			throw err;
		}
	}

	private async provisionInto(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
	): Promise<ProvisionResult> {
		const nb = paths.project(options.projectId).notebook(options.notebookId);
		const workdir = options.workdir ?? DEFAULT_WORKDIR;
		const mountPath = workdir;
		const sw = new Stopwatch();

		const ensureReachable = () => this.ensureReachable(sandbox, sw);
		const loadWorkspace = () =>
			withSandboxSpan(sw, 'files', async (time, span) => {
				const loaded = await time(() =>
					this.loadWorkspace(
						sandbox,
						options,
						mountPath,
						options.workspacePrefix ?? nb.workspacePrefix,
					),
				);
				span.setAttributes({
					objects: loaded.stats?.objectCount ?? 0,
					bytes: loaded.stats?.bytes ?? 0,
					used_fallback: loaded.usedFallback,
				});
				return loaded;
			});
		const injectSessionEnv = () =>
			withSandboxSpan(sw, 'inject', (time) => this.injectSessionEnv(sandbox, options, time));
		const setupEnvironment = () => this.setupEnvironment(sandbox, options, mountPath, sw);
		const launchKernel = (startup: MarimoStartup) =>
			this.launchKernel(sandbox, mountPath, sw, startup);
		const exposeKernel = () => this.exposeKernel(sandbox, options, sw);

		// Setup reads only the loaded workspace, so credential resolution and injection
		// can overlap it. The kernel still waits for both to finish.
		const { load, expose } = await all({
			async reachable() {
				await ensureReachable();
			},
			async load() {
				await this.$.reachable;
				return loadWorkspace();
			},
			async inject() {
				await this.$.reachable;
				await injectSessionEnv();
			},
			async setup() {
				await this.$.load;
				return setupEnvironment();
			},
			async start() {
				const startup = await this.$.setup;
				await this.$.inject;
				await launchKernel(startup);
			},
			async expose() {
				await this.$.start;
				return exposeKernel();
			},
		});

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
		// Last: the adapter's command count is only final once every phase has run.
		Object.assign(counters, sandbox.drainCounters?.() ?? {});

		return { sandbox, url: expose, usedFallback: load.usedFallback, timings: sw.timings, counters };
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
		mountPath: string,
		workspacePrefix: string,
	): Promise<WorkspaceLoadResult> {
		const loaded = await this.restoreWorkspaceFiles(sandbox, options, mountPath, workspacePrefix);
		if (options.gitPrefix) {
			await this.markGitWorkdirTrusted(sandbox, mountPath);
		}
		return loaded;
	}

	private async restoreWorkspaceFiles(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		workspacePrefix: string,
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
				mountPath,
				Boolean(options.gitPrefix),
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
				mountPath,
				workspacePrefix,
			);
			return {
				...fallback,
				archiveStatus: packed.status === 'missing' ? 'missing' : 'failed',
			};
		}
		return this.loadWorkspaceObjects(sandbox, options, mountPath, workspacePrefix);
	}

	private async markGitWorkdirTrusted(sandbox: SandboxInstance, workdir: string): Promise<void> {
		// Restored `.git` is often a different uid than the kernel user (Modal).
		await sandbox.exec(
			`if command -v git >/dev/null 2>&1; then git config --global --add safe.directory ${shellQuote(workdir)}; fi`,
		);
	}

	private async loadWorkspaceObjects(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		workspacePrefix: string,
	): Promise<WorkspaceLoadResult> {
		const strategy =
			options.workspaceLoadMode === 'copy-only'
				? this.workspaceLoadStrategies.copyOnly
				: this.workspaceLoadStrategies.mountOrCopy;
		const load = strategy.load({
			sandbox,
			projectId: options.projectId,
			notebookId: options.notebookId,
			bucket: options.bucket,
			bucketHandle: options.bucketHandle,
			mountPath,
			workspacePrefix,
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
					`${mountPath}/.git`,
					{ requireComplete: true },
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
		const [loaded, gitStats] = copyPath
			? await Promise.all([load, restoreGit()])
			: [await load, await restoreGit()];
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
	): Promise<void> {
		const sessionEnv = await options.sessionEnv;
		if (!sessionEnv) return;
		await time(async () => {
			try {
				// The credential files go in one write; env vars are a separate channel, so
				// the round-trips overlap.
				const files = sessionEnv.files ?? [];
				const vars = sessionEnv.vars;
				const defaults = sessionEnv.defaults;
				await Promise.all([
					files.length > 0 ? sandbox.writeFiles(files) : undefined,
					vars && Object.keys(vars).length > 0 ? sandbox.setEnvVars(vars) : undefined,
					defaults && Object.keys(defaults).length > 0
						? sandbox.setEnvVars(defaults, { onlyIfUnset: true })
						: undefined,
				]);
			} catch (err) {
				throw provisionFailure('injecting session credentials', err);
			}
		});
	}

	private async setupEnvironment(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		sw: Stopwatch,
	): Promise<MarimoStartup> {
		const startup: MarimoStartup = {
			plan: buildMarimoLaunch(
				{
					notebookFile: options.entryNotebook ?? 'notebook.py',
					port: MARIMO_PORT,
					host: '0.0.0.0',
					mode: options.launchMode,
					assetUrl: options.assetUrl,
					baseUrl: options.baseUrl,
					watch: options.marimoWatch,
				},
				options.launchStrategy,
			),
			deadline: {
				startedAt: Date.now(),
				timeoutMs: options.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
			},
		};
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
					if (!result.success) throw pythonEnvironmentSetupFailure(result);
				},
				{ launch_strategy: options.launchStrategy ?? DEFAULT_LAUNCH_STRATEGY },
			);
		} catch (error) {
			if (error instanceof PythonEnvironmentSetupError) throw error;
			throw provisionFailure('preparing the notebook Python environment', error);
		} finally {
			if (diagnostics) logSlowSetup(options, sw.timings.setup, diagnostics);
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
				port: MARIMO_PORT,
				waitForPort: { mode: 'tcp' },
				startupTimeout: timeoutMs,
			});
		} catch (error) {
			throw provisionFailure('starting the marimo kernel', error);
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
	): Promise<string> {
		try {
			const { url } = await withSandboxSpan(sw, 'expose', (time) =>
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
		if (!workspaceSourcePolicy(source).persistSessionEdits) return false;

		const mountPath = workdir;
		// The commit chain and the workspace mirror are independent best-effort
		// steps over disjoint bucket keys, so they run concurrently.
		const { commit, workspace } = await allSettled({
			async commit() {
				const artifacts = await readSessionArtifacts(sandbox, mountPath);
				await notebooks.commitSession(projectId, notebookId, artifacts, actor);
			},
			async workspace() {
				if (opts?.includeWorkspace === false) return;
				await captureWorkspace(sandbox, bucket, projectId, notebookId, mountPath, persistWorkspace);
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
	 * (`workspace/notebook.py` + `workspace/pyproject.toml`) and the immutable
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
		let persisted = true;
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
