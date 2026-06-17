import { getSandbox, proxyToSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { SandboxId } from '@marimo-hub/core';
import type {
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	GitCheckoutOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	StartProcessOptions,
} from '@marimo-hub/core/ports';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SandboxType = Sandbox<any>;

const SLEEP_AFTER = '20m';

class CloudflareSandboxInstance implements SandboxInstance {
	private sandbox: SandboxType;

	constructor(sandbox: SandboxType) {
		this.sandbox = sandbox;
	}

	async exec(cmd: string): Promise<ExecResult> {
		const res = await this.sandbox.exec(cmd);
		return { success: res.success, stdout: res.stdout, stderr: res.stderr };
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		return this.sandbox.execStream(cmd, {
			timeout: options?.timeout,
		});
	}

	async readFile(path: string): Promise<ReadFileResult> {
		const res = await this.sandbox.readFile(path);
		return { success: res.success, content: res.content, encoding: res.encoding };
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		const res = await this.sandbox.listFiles(path, options);
		return {
			success: res.success,
			files: res.files.map((f) => ({
				name: f.name,
				absolutePath: f.absolutePath,
				relativePath: f.relativePath,
				type: f.type,
				size: f.size,
			})),
		};
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.sandbox.writeFile(path, content);
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		await this.sandbox.gitCheckout(repo, options);
	}

	async setEnvVars(vars: Record<string, string>): Promise<void> {
		await this.sandbox.setEnvVars(vars);
	}

	async mountBucket(options: MountBucketOptions): Promise<void> {
		await this.sandbox.mountBucket(options.bucketName, options.mountPath, {
			endpoint: options.endpoint,
			prefix: options.prefix,
			credentials: options.credentials,
		});
	}

	async unmountBucket(mountPath: string): Promise<void> {
		await this.sandbox.unmountBucket(mountPath);
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const proc = await this.sandbox.startProcess(cmd, {
			processId: options?.processId,
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
		});
		return {
			get id() {
				return proc.id;
			},
			get command() {
				return proc.command;
			},
			kill: (signal?: string) => proc.kill(signal),
			waitForPort: (port, opts) => proc.waitForPort(port, opts),
			getLogs: () => proc.getLogs(),
		};
	}

	async exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		const result = await this.sandbox.exposePort(port, options);
		return { url: result.url };
	}

	async destroy(): Promise<void> {
		await this.sandbox.destroy();
	}
}

export class CloudflareSandboxProvider implements SandboxProvider {
	private namespace: DurableObjectNamespace<SandboxType>;

	constructor(namespace: DurableObjectNamespace<SandboxType>) {
		this.namespace = namespace;
	}

	create(id: SandboxId): SandboxInstance {
		return new CloudflareSandboxInstance(
			getSandbox(this.namespace, id, {
				sleepAfter: SLEEP_AFTER,
			}),
		);
	}

	async proxy(request: Request): Promise<Response | null> {
		// proxyToSandbox reads `env.Sandbox` (see SandboxEnv); the key must be
		// `Sandbox` regardless of the wrangler binding name (`SANDBOX`).
		return proxyToSandbox(request, { Sandbox: this.namespace });
	}
}

// Re-export the Sandbox Durable Object class for wrangler to discover.
export { Sandbox } from '@cloudflare/sandbox';
