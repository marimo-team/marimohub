import type { SandboxId } from '../ids';

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
	bucketName: string;
	endpoint: string;
	mountPath: string;
	prefix: string;
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

export interface SandboxInstance {
	exec(cmd: string): Promise<ExecResult>;
	execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream>;
	readFile(path: string): Promise<ReadFileResult>;
	listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
	writeFile(path: string, content: string): Promise<void>;
	gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void>;
	setEnvVars(vars: Record<string, string>): Promise<void>;
	mountBucket(options: MountBucketOptions): Promise<void>;
	unmountBucket(mountPath: string): Promise<void>;
	startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess>;
	exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult>;
	destroy(): Promise<void>;
}

export interface ActiveSandbox {
	id: SandboxId;
	/** ISO timestamp the provider reports for sandbox creation, if available. */
	createdAt?: string;
}

export interface SandboxProvider {
	create(id: SandboxId): SandboxInstance;
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
