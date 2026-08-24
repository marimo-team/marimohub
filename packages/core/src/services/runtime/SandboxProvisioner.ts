import { all, allSettled } from 'better-all';
import type { Bucket } from '../../ports/bucket';
import { MARIMO_PORT } from '../../constants';
import type { SessionMode } from '../../constants';
import { Millis } from '../../duration';
import { UnavailableError } from '../../errors';
import type { NotebookId, ProjectId, SandboxId, UserId } from '../../ids';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import type { WorkspaceLoadMode } from '../../integrations/remoteWorkspace';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import type {
	ComputeResources,
	SandboxUserHome,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
} from '../../ports/sandbox';
import { Stopwatch } from '../../timing';
import type { Timings } from '../../timing';
import { captureFilesystemSnapshot, createOrRestoreSandbox } from '../content/filesystemSnapshots';
import { buildMarimoLaunch } from './marimoLaunch';
import type { MarimoLaunchStrategyName } from './marimoLaunch';
import type { NotebookService } from '../content/NotebookService';
import { captureWorkspace, readSessionArtifacts, restoreWorkspace } from './sandboxFiles';
import type { WorkspaceRestoreStats } from './sandboxFiles';

/**
 * Default wait for marimo to bind its port (override per deployment via
 * `startupTimeoutMs`, config: MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS).
 * Generous because a cold sandbox may build its uv venv from scratch (e.g. the
 * `uv-sandbox` launch strategy resolves + downloads the notebook's deps on
 * first boot). See marimoLaunch.ts.
 */
export const DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS = Millis.minutes(2);
/**
 * Default sandbox working directory. Override per-deployment via the `workdir`
 * option (config: MARIMOHUB_COMPUTE_WORKDIR) when the sandbox image's user can't
 * write here — e.g. the marimo OSS image runs as a non-root user with no
 * `/workspace`, so writes there fail with a permission/file-IO error.
 */
const DEFAULT_WORKDIR = '/workspace';

export interface BucketConfig {
	/** Storage bucket name, or a provider-managed bucket handle when `endpoint` is omitted. */
	name: string;
	/** S3 endpoint; optional — omit for providers that mount a bucket without one. */
	endpoint?: string;
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
	 * How long to wait for the marimo kernel to bind its port before failing the
	 * provision. Covers setup too (a cold env may install/build first). Defaults
	 * to `DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS`.
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
}

export interface ProvisionResult {
	sandbox: SandboxInstance;
	url: string;
	/** Whether files were loaded via manual copy (true) or bucket mount (false) */
	usedFallback: boolean;
	/** Wall-clock total and per-phase ms: handle, reachable, files, inject, start, waitport, expose. */
	timings: Timings;
	/**
	 * Non-duration measurements for the same wide event — workspace objects/bytes
	 * copied, command round-trips. Kept apart from `timings` so nothing here gets
	 * reported as milliseconds.
	 */
	counters: Record<string, number>;
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

/**
 * On scope exit, fold any timings the adapter recorded internally into `sw` under
 * `<phase>_`. CoreWeave resolves its sandbox lazily, so its create/find ms would
 * otherwise be invisible — buried inside whichever span triggered the first call.
 */
function drainTimingsInto(sandbox: SandboxInstance, sw: Stopwatch, phase: string): Disposable {
	return {
		[Symbol.dispose]() {
			for (const [name, ms] of Object.entries(sandbox.drainTimings?.() ?? {})) {
				sw.timings[`${phase}_${name}`] = ms;
			}
		},
	};
}

export interface WorkspaceLoadContext {
	sandbox: SandboxInstance;
	projectId: ProjectId;
	notebookId: NotebookId;
	bucket: BucketConfig;
	bucketHandle?: Bucket;
	mountPath: string;
	workspacePrefix: string;
}

export interface WorkspaceLoadResult {
	/** Files were copied in (true) rather than bucket-mounted (false). */
	usedFallback: boolean;
	/** What the copy moved; absent when the workspace was mounted instead. */
	stats?: WorkspaceRestoreStats;
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
	}: WorkspaceLoadContext): Promise<WorkspaceLoadResult> {
		if (!bucketHandle) {
			throw provisionFailure(
				'restoring the notebook workspace into the sandbox',
				new Error('bucket handle is required for copy-only workspace loading'),
			);
		}
		try {
			const stats = await restoreWorkspace(sandbox, bucketHandle, workspacePrefix, mountPath);
			return { usedFallback: true, stats };
		} catch (err) {
			throw provisionFailure('restoring the notebook workspace into the sandbox', err);
		}
	}
}

class MountOrCopyWorkspaceLoadStrategy implements WorkspaceLoadStrategy {
	constructor(private copyFallback: WorkspaceLoadStrategy) {}

	async load(ctx: WorkspaceLoadContext): Promise<WorkspaceLoadResult> {
		if (ctx.sandbox.supportsBucketMount === false) return this.copyFallback.load(ctx);
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
			this.loadWorkspace(
				sandbox,
				options,
				mountPath,
				options.workspacePrefix ?? nb.workspacePrefix,
				sw,
			);
		const injectSessionEnv = () => this.injectSessionEnv(sandbox, options, sw);
		const startMarimoKernel = () => this.startMarimoKernel(sandbox, options, mountPath, sw);
		const exposeKernel = () => this.exposeKernel(sandbox, options, sw);

		// The workspace load and the credential inject touch disjoint targets (the
		// mount path vs. credential file paths + env vars), so they overlap; the
		// kernel start needs both. Note `files`/`inject` timings overlap too.
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
			async start() {
				await this.$.load;
				await this.$.inject;
				await startMarimoKernel();
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
		// Last: the adapter's command count is only final once every phase has run.
		Object.assign(counters, sandbox.drainCounters?.() ?? {});

		return { sandbox, url: expose, usedFallback: load.usedFallback, timings: sw.timings, counters };
	}

	private async ensureReachable(sandbox: SandboxInstance, sw: Stopwatch): Promise<void> {
		using _drained = drainTimingsInto(sandbox, sw, 'reachable');
		try {
			// Adapters without `ready()` fall back to a no-op command, which proves the
			// same thing at the cost of a round-trip.
			await sw.time('reachable', async () => {
				await (sandbox.ready?.() ?? sandbox.exec('true'));
			});
		} catch (err) {
			throw new UnavailableError('Sandbox compute backend is not available', { cause: err });
		}
	}

	private async loadWorkspace(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		workspacePrefix: string,
		sw: Stopwatch,
	): Promise<WorkspaceLoadResult> {
		using _files = sw.span('files');
		const strategy =
			options.workspaceLoadMode === 'copy-only'
				? this.workspaceLoadStrategies.copyOnly
				: this.workspaceLoadStrategies.mountOrCopy;
		const loaded = await strategy.load({
			sandbox,
			projectId: options.projectId,
			notebookId: options.notebookId,
			bucket: options.bucket,
			bucketHandle: options.bucketHandle,
			mountPath,
			workspacePrefix,
		});
		if (!options.gitPrefix) return loaded;
		try {
			if (!options.bucketHandle) {
				throw new Error('bucket handle is required for Git metadata restoration');
			}
			const gitStats = await restoreWorkspace(
				sandbox,
				options.bucketHandle,
				options.gitPrefix,
				`${mountPath}/.git`,
				{ requireComplete: true },
			);
			if (gitStats.objectCount === 0) {
				throw new Error('the stored Git directory is empty');
			}
			if (!loaded.stats) return { ...loaded, stats: gitStats };
			return {
				...loaded,
				stats: {
					objectCount: loaded.stats.objectCount + gitStats.objectCount,
					bytes: loaded.stats.bytes + gitStats.bytes,
				},
			};
		} catch (error) {
			logOperationalError(
				'git_workspace_restore_failed',
				{
					operation: 'session.git.restore',
					object: options.gitPrefix,
					project_id: options.projectId,
					notebook_id: options.notebookId,
				},
				error,
			);
			throw provisionFailure('restoring Git metadata into the sandbox', error);
		}
	}

	private async injectSessionEnv(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		sw: Stopwatch,
	): Promise<void> {
		const sessionEnv = await options.sessionEnv;
		if (!sessionEnv) return;
		using _inject = sw.span('inject');
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
	}

	private async startMarimoKernel(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		sw: Stopwatch,
	): Promise<void> {
		const launch = buildMarimoLaunch(
			{
				notebookFile: options.entryNotebook ?? 'notebook.py',
				port: MARIMO_PORT,
				host: '0.0.0.0',
				mode: options.launchMode,
				assetUrl: options.assetUrl,
				baseUrl: options.baseUrl,
			},
			options.launchStrategy,
		);
		const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS;
		let process: SandboxProcess | undefined;
		let portWaitStart: number | undefined;
		try {
			// Setup rides the kernel command instead of spending its own exec, and
			// failures still surface through the process log read below. `&&` so a
			// failed setup never leaves marimo running against a half-built env;
			// marimoLaunch decides what is fatal.
			const command = [...launch.setup, launch.start].join(' && ');
			const proc = await sw.time('start', () => sandbox.startProcess(command, { cwd: mountPath }));
			process = proc;
			portWaitStart = Date.now();
			// Covers setup as well, so a slow kernel env (install/build) shows up here.
			await sw.time('waitport', () => proc.waitForPort(MARIMO_PORT, { timeout: startupTimeoutMs }));
		} catch (err) {
			// Surface the kernel's own output so a startup crash isn't an opaque
			// "exited before ready". Best-effort.
			let kernelLogs = '';
			if (process) {
				try {
					const { stdout, stderr } = await process.getLogs();
					kernelLogs = [stdout, stderr]
						.filter((s) => s.trim())
						.join('\n')
						.trim();
				} catch {
					// getLogs can fail once the process/sandbox is gone — ignore.
				}
			}
			// `provisionFailure` drops the adapter's message, so a deadline-shaped
			// failure must be classified here or the caller can't tell "kernel took
			// too long" (raise the timeout) from "kernel crashed" (read the logs).
			// A wait that consumed the full window is a timeout — unless the adapter
			// already attributed the failure to the process ("… before port N …",
			// the shared wording of the exited-early errors): crash detection can
			// land arbitrarily close to the deadline, and elapsed time alone would
			// then tell the operator to raise the timeout for a crash. Only the
			// FIRST line is the adapter's attribution — the rest is appended
			// process output, which can echo a "before port" phrase into a genuine
			// timeout message.
			const attribution = err instanceof Error ? err.message.split('\n', 1)[0] : '';
			const crashed = /before port \d+/.test(attribution);
			const timedOut =
				!crashed && portWaitStart !== undefined && Date.now() - portWaitStart >= startupTimeoutMs;
			const step = timedOut
				? `starting the marimo kernel: not ready within the ${Math.round(startupTimeoutMs / 1000)}s startup timeout (MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS)`
				: 'starting the marimo kernel';
			throw provisionFailure(kernelLogs ? `${step}; kernel output:\n${kernelLogs}` : step, err);
		}
	}

	private async exposeKernel(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		sw: Stopwatch,
	): Promise<string> {
		try {
			const { url } = await sw.time('expose', () =>
				sandbox.exposePort(MARIMO_PORT, {
					hostname: options.hostname,
					token: options.sandboxId,
				}),
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
