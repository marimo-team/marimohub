import type { SandboxId } from '../ids';
import type { Timings } from '../timing';

export interface ExecResult {
	success: boolean;
	stdout: string;
	stderr: string;
}

export interface GitCheckoutOptions {
	targetDir?: string;
	branch?: string;
}

export interface MountBucketOptions {
	/**
	 * What to mount: the storage bucket name when `endpoint` is set, otherwise a
	 * provider-managed bucket handle (for providers that mount without an endpoint).
	 */
	bucketName: string;
	mountPath: string;
	prefix: string;
	/**
	 * S3-compatible endpoint. Optional — some providers mount a bucket directly,
	 * with no endpoint or credentials passed into the sandbox.
	 */
	endpoint?: string;
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	};
}

export interface StartProcessOptions {
	processId?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeout?: number;
}

export interface WaitForPortOptions {
	mode?: 'http' | 'tcp';
	path?: string;
	timeout?: number;
}

export interface SandboxProcess {
	readonly id: string;
	readonly command: string;
	kill(signal?: string): Promise<void>;
	waitForPort(port: number, options?: WaitForPortOptions): Promise<void>;
	getLogs(): Promise<{ stdout: string; stderr: string }>;
}

export interface ReadFileResult {
	success: boolean;
	content: string;
	encoding?: 'utf-8' | 'base64';
}

export interface FileInfo {
	name: string;
	absolutePath: string;
	relativePath: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
}

export interface ListFilesResult {
	success: boolean;
	files: FileInfo[];
}

export interface ListFilesOptions {
	recursive?: boolean;
	includeHidden?: boolean;
}

export interface ExposePortOptions {
	hostname: string;
	token?: string;
	name?: string;
}

export interface ExposePortResult {
	url: string;
}

export interface ExecStreamOptions {
	timeout?: number;
}

/** One file to write into a sandbox. `Uint8Array` content is written verbatim. */
export interface SandboxFileWrite {
	path: string;
	content: string | Uint8Array;
}

export interface SandboxInstance {
	exec(cmd: string): Promise<ExecResult>;
	execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream>;
	readFile(path: string): Promise<ReadFileResult>;
	listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
	/**
	 * Write a set of files, creating parent directories. Always a set, so the
	 * adapter owns HOW: a backend with a native multi-file API sends one call,
	 * others loop with bounded parallelism — the caller never has to know which.
	 *
	 * `content` may be raw bytes, written verbatim; a backend whose write channel
	 * carries only text armors them itself. Callers must bound how much they pass
	 * at once — the whole set is resident in memory.
	 */
	writeFiles(files: readonly SandboxFileWrite[]): Promise<void>;
	gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void>;
	setEnvVars(vars: Record<string, string>): Promise<void>;
	mountBucket(options: MountBucketOptions): Promise<void>;
	unmountBucket(mountPath: string): Promise<void>;
	startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess>;
	exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult>;
	destroy(): Promise<void>;
	/**
	 * Return and CLEAR phase timings the adapter recorded internally — e.g. an
	 * adapter that resolves its sandbox lazily can report what the first call
	 * actually spent. Optional; the provisioner folds them into its own timings.
	 */
	drainTimings?(): Timings;
}

export interface ActiveSandbox {
	id: SandboxId;
	/** ISO timestamp the provider reports for sandbox creation, if available. */
	createdAt?: string;
}

export interface CreateSandboxOptions {
	/**
	 * May the adapter reconnect to an existing sandbox with this id instead of
	 * creating one? Default true — teardown/reconnect re-resolve by id and need it.
	 * A fresh provision passes false: nothing can match yet, so the lookup is a
	 * wasted round-trip on the critical path.
	 */
	reuse?: boolean;
	/**
	 * Override the adapter's configured default image for THIS sandbox — a
	 * container image (modal/coreweave/docker/kubernetes) or an E2B template id.
	 * Omitted → the adapter's constructor default. Ignored by `local`.
	 */
	image?: string;
}

export interface SandboxProvider {
	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance;
	/**
	 * Proxy an incoming request to a sandbox's exposed port.
	 * Returns a Response if the request matched a sandbox URL, null otherwise.
	 */
	proxy(request: Request): Promise<Response | null>;
	/**
	 * List the sandboxes the provider currently considers live, scoped to those
	 * THIS deployment owns (never co-tenant sandboxes in a shared account).
	 *
	 * Optional: providers that cannot enumerate omit it, and the reconciler skips
	 * provider-truth reconciliation for them. The returned `id` MUST equal the
	 * `sandbox_id` stored on the session record, so the reconciler can match a
	 * provider sandbox back to its record (or detect that none exists).
	 */
	listActive?(): Promise<ActiveSandbox[]>;
}

/**
 * OPTIONAL, backend-specific capability, deliberately kept OFF the
 * `SandboxInstance`/`SandboxProvider` contract so it never bloats what every
 * adapter must implement. Only CoreWeave implements it (gated by
 * `MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT`): capture the whole container
 * filesystem (venv, packages, caches) on teardown and boot the next session FROM
 * the snapshot. Detected via `asFilesystemSnapshots()`, mirroring the optional
 * `listActive?()` pattern; a no-op on every other backend.
 *
 * Independent of `MARIMOHUB_PERSIST_WORKSPACE` (vendor-neutral working-dir capture
 * into the bucket); enabling both double-persists state. Both off by default.
 */
export interface FilesystemSnapshots {
	/** Whether the feature is enabled for this provider (its config flag). */
	readonly filesystemSnapshotsEnabled: boolean;
	/** Create a sandbox restored FROM a native snapshot (boots from the image). */
	createFromSnapshot(id: SandboxId, snapshotId: string): SandboxInstance;
	/** Capture the full filesystem of a live sandbox; returns the native snapshot id. */
	captureSnapshot(sandbox: SandboxInstance): Promise<{ snapshotId: string; sizeBytes?: number }>;
	/** Delete a native snapshot (best-effort latest-wins GC; tolerates not-found). */
	deleteSnapshot(snapshotId: string): Promise<void>;
}

/**
 * Narrow a provider to its optional `FilesystemSnapshots` capability, or
 * `undefined` when the backend does not support it (or has it disabled). The
 * provisioner gates every snapshot path on this, so non-CoreWeave backends —
 * which never implement these methods — silently skip capture/restore/GC.
 */
export function asFilesystemSnapshots(p: SandboxProvider): FilesystemSnapshots | undefined {
	const c = p as Partial<FilesystemSnapshots>;
	return c.filesystemSnapshotsEnabled &&
		typeof c.createFromSnapshot === 'function' &&
		typeof c.captureSnapshot === 'function' &&
		typeof c.deleteSnapshot === 'function'
		? (p as unknown as FilesystemSnapshots)
		: undefined;
}
