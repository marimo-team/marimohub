import { all, allSettled } from 'better-all';
import type { Bucket } from '../../ports/bucket';
import { MARIMO_PORT } from '../../constants';
import type { SessionMode } from '../../constants';
import { UnavailableError } from '../../errors';
import type { NotebookId, ProjectId, SandboxId, UserId } from '../../ids';
import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import type { WorkspaceLoadMode } from '../../integrations/remoteWorkspace';
import { paths } from '../../paths';
import type {
	ComputeResources,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
} from '../../ports/sandbox';
import { Stopwatch } from '../../timing';
import type { Timings } from '../../timing';
import { captureFilesystemSnapshot, createOrRestoreSandbox } from '../content/filesystemSnapshots';
import { buildMarimoLaunch } from './marimoLaunch';
import type { NotebookService } from '../content/NotebookService';
import { captureWorkspace, readSessionArtifacts, restoreWorkspace } from './sandboxFiles';
import { shellQuote } from './shell';

/**
 * How long to wait for marimo to bind its port. Generous because a cold sandbox
 * may build its uv venv from scratch (e.g. the `uv-sandbox` launch strategy
 * resolves + downloads the notebook's deps on first boot). See marimoLaunch.ts.
 */
const MARIMO_PORT_TIMEOUT_MS = 120_000; // 2 minutes
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
}

export interface ProvisionResult {
	sandbox: SandboxInstance;
	url: string;
	/** Whether files were loaded via manual copy (true) or bucket mount (false) */
	usedFallback: boolean;
	/** Per-phase ms: create, reachable, files, setup, start, waitport, expose. */
	timings: Timings;
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
	const wrapped = new UnavailableError(parts.join(' '));
	(wrapped as { cause?: unknown }).cause = err;
	return wrapped;
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

export interface WorkspaceLoadStrategy {
	load(ctx: WorkspaceLoadContext): Promise<boolean>;
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
	}: WorkspaceLoadContext): Promise<boolean> {
		if (!bucketHandle) {
			throw provisionFailure(
				'restoring the notebook workspace into the sandbox',
				new Error('bucket handle is required for copy-only workspace loading'),
			);
		}
		try {
			await restoreWorkspace(sandbox, bucketHandle, workspacePrefix, mountPath);
			return true;
		} catch (err) {
			throw provisionFailure('restoring the notebook workspace into the sandbox', err);
		}
	}
}

class MountOrCopyWorkspaceLoadStrategy implements WorkspaceLoadStrategy {
	constructor(private copyFallback: WorkspaceLoadStrategy) {}

	async load(ctx: WorkspaceLoadContext): Promise<boolean> {
		try {
			await ctx.sandbox.mountBucket({
				bucketName: ctx.bucket.name,
				endpoint: ctx.bucket.endpoint,
				mountPath: ctx.mountPath,
				prefix: ctx.workspacePrefix,
				credentials: ctx.bucket.credentials,
			});
			return false;
		} catch (err) {
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
		// A restored sandbox boots from the snapshot image; the workspace load below
		// still refreshes the code from the bucket cache.
		const createStart = Date.now();
		const sandbox = createOrRestoreSandbox(
			this.provider,
			options.sandboxId,
			options.restoreFilesystemSnapshotId,
			options.image,
			options.resources,
		);
		const createMs = Date.now() - createStart;
		try {
			const result = await this.provisionInto(sandbox, options);
			result.timings.create = createMs;
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

		return { sandbox, url: expose, usedFallback: load, timings: sw.timings };
	}

	private async ensureReachable(sandbox: SandboxInstance, sw: Stopwatch): Promise<void> {
		using _drained = drainTimingsInto(sandbox, sw, 'reachable');
		try {
			await sw.time('reachable', () => sandbox.exec('true'));
		} catch (err) {
			throw new UnavailableError(
				`Sandbox container is not available. Is Docker running? ` +
					`(${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}

	private async loadWorkspace(
		sandbox: SandboxInstance,
		options: ProvisionOptions,
		mountPath: string,
		workspacePrefix: string,
		sw: Stopwatch,
	): Promise<boolean> {
		using _files = sw.span('files');
		const strategy =
			options.workspaceLoadMode === 'copy-only'
				? this.workspaceLoadStrategies.copyOnly
				: this.workspaceLoadStrategies.mountOrCopy;
		return await strategy.load({
			sandbox,
			projectId: options.projectId,
			notebookId: options.notebookId,
			bucket: options.bucket,
			bucketHandle: options.bucketHandle,
			mountPath,
			workspacePrefix,
		});
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
		const launch = buildMarimoLaunch({
			notebookFile: options.entryNotebook ?? 'notebook.py',
			port: MARIMO_PORT,
			host: '0.0.0.0',
			mode: options.launchMode,
			assetUrl: options.assetUrl,
			baseUrl: options.baseUrl,
		});
		let process: SandboxProcess | undefined;
		try {
			// cwd is the loaded workspace so marimo resolves relative imports and files
			// beside the notebook. exec takes no cwd, so setup commands cd in first.
			await sw.time('setup', async () => {
				for (const cmd of launch.setup) {
					const res = await sandbox.exec(`cd ${shellQuote(mountPath)} && ${cmd}`);
					if (!res.success) {
						throw new Error(`marimo launch setup failed (${cmd}): ${res.stderr || res.stdout}`);
					}
				}
			});
			const proc = await sw.time('start', () =>
				sandbox.startProcess(launch.start, { cwd: mountPath }),
			);
			process = proc;
			// `waitport` is where a slow kernel env (install/build) shows up.
			await sw.time('waitport', () =>
				proc.waitForPort(MARIMO_PORT, { timeout: MARIMO_PORT_TIMEOUT_MS }),
			);
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
			throw provisionFailure(
				kernelLogs
					? `starting the marimo kernel; kernel output:\n${kernelLogs}`
					: 'starting the marimo kernel',
				err,
			);
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
				console.error(`commitSession failed for notebook ${notebookId}:`, commitError);
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
			console.error(`captureSession failed during teardown for notebook ${notebookId}:`, err);
		}
		if (persisted) {
			// Snapshot before destroy, once the session state above is final. Both are
			// sandbox RPCs: a transient gRPC stream reset here must not reject teardown,
			// and destroy must run regardless so the sandbox cannot linger and bill.
			try {
				await captureFilesystemSnapshot(this.provider, notebooks, sandbox, projectId, notebookId, {
					compute_profile: opts?.computeProfile,
					compute_resources: opts?.computeResources,
				});
			} catch (err) {
				console.error(
					`captureFilesystemSnapshot failed during teardown for notebook ${notebookId}:`,
					err,
				);
			}
		}
		try {
			await sandbox.destroy();
		} catch (err) {
			console.error(`sandbox.destroy failed during teardown for notebook ${notebookId}:`, err);
		}
	}
}
