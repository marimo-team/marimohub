/**
 * Modal compute adapter — a `SandboxProvider` backed by Modal sandboxes.
 *
 * This is the de-facto compute backend for the Node/Kubernetes control plane:
 * unlike Cloudflare Containers (reachable only from a Workers runtime), Modal
 * exposes an HTTP API callable from anywhere, and Modal sandboxes get a public
 * tunnel URL — so `proxy()` is a no-op (the SPA hits the kernel URL directly).
 *
 * NOTE: the exact Modal request shapes below are the integration surface to
 * validate against Modal's live sandbox API before production use (this is the
 * "prototype Modal first" risk called out in the migration plan). Methods not
 * needed by the provisioning path are best-effort.
 */
import type {
	ActiveSandbox,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	GitCheckoutOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxId,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';

export interface ModalConfig {
	tokenId: string;
	tokenSecret: string;
	/** Sandbox image reference (a Modal image with marimo + uv + python). */
	image: string;
	/** Modal API base URL. */
	apiBase?: string;
	/** Modal app name that owns the sandboxes. */
	appName?: string;
	/** Idle timeout before Modal auto-stops the sandbox (e.g. '20m'). */
	idleTimeout?: string;
}

const DEFAULT_API_BASE = 'https://api.modal.com';
const DEFAULT_APP_NAME = 'marimohub';

/**
 * Authenticated request to Modal's API. Endpoints/shapes are the integration
 * surface to validate against the live API (see file header). Shared by the
 * per-sandbox instance and the provider-level `listActive()`.
 */
async function modalRequest<T>(
	config: ModalConfig,
	path: string,
	options?: { method?: string; body?: unknown },
): Promise<T> {
	const apiBase = config.apiBase ?? DEFAULT_API_BASE;
	const res = await fetch(`${apiBase}${path}`, {
		method: options?.method ?? 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Modal-Key': config.tokenId,
			'Modal-Secret': config.tokenSecret,
		},
		body: options?.body === undefined ? undefined : JSON.stringify(options.body),
	});
	if (!res.ok) {
		throw new Error(`Modal API ${path} failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as T;
}

class ModalSandboxInstance implements SandboxInstance {
	constructor(
		private readonly id: SandboxId,
		private readonly config: ModalConfig,
	) { }

	private get apiBase(): string {
		return this.config.apiBase ?? DEFAULT_API_BASE;
	}

	/** Authenticated POST to Modal's API. Endpoints are the integration surface. */
	private modal<T>(path: string, body?: unknown): Promise<T> {
		return modalRequest<T>(this.config, path, { body });
	}

	async exec(cmd: string): Promise<ExecResult> {
		const res = await this.modal<{ exit_code: number; stdout: string; stderr: string }>(
			`/v1/sandboxes/${this.id}/exec`,
			{ command: ['sh', '-lc', cmd] },
		);
		return { success: res.exit_code === 0, stdout: res.stdout, stderr: res.stderr };
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		const res = await fetch(`${this.apiBase}/v1/sandboxes/${this.id}/exec?stream=1`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Modal-Key': this.config.tokenId,
				'Modal-Secret': this.config.tokenSecret,
			},
			body: JSON.stringify({ command: ['sh', '-lc', cmd] }),
		});
		if (!res.ok || !res.body) {
			throw new Error(`Modal exec stream failed: ${res.status}`);
		}
		return res.body;
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const res = await this.modal<{ content: string }>(`/v1/sandboxes/${this.id}/files/read`, {
				path,
			});
			return { success: true, content: res.content, encoding: 'utf-8' };
		} catch {
			return { success: false, content: '' };
		}
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.modal(`/v1/sandboxes/${this.id}/files/write`, { path, content });
	}

	async listFiles(path: string, _options?: ListFilesOptions): Promise<ListFilesResult> {
		const res = await this.modal<{ files: ListFilesResult['files'] }>(
			`/v1/sandboxes/${this.id}/files/list`,
			{ path },
		);
		return { success: true, files: res.files ?? [] };
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const target = options?.targetDir ?? '.';
		const branch = options?.branch ? `-b ${options.branch}` : '';
		await this.exec(`git clone ${branch} ${repo} ${target}`);
	}

	async setEnvVars(vars: Record<string, string>): Promise<void> {
		await this.modal(`/v1/sandboxes/${this.id}/env`, { env: vars });
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// Modal sandboxes don't FUSE-mount an external S3 bucket here. Throwing makes
		// SandboxProvisioner fall back to copy-in/copy-out (sandboxFiles), which is
		// the intended path for the Modal backend.
		throw new Error('mountBucket is not supported on the Modal backend; using file copy fallback');
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// no-op
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const res = await this.modal<{ process_id: string }>(`/v1/sandboxes/${this.id}/processes`, {
			command: ['sh', '-lc', cmd],
			cwd: options?.cwd,
			env: options?.env,
		});
		const processId = res.process_id;
		const self = this;
		return {
			id: processId,
			command: cmd,
			async kill(signal?: string): Promise<void> {
				await self.modal(`/v1/sandboxes/${self.id}/processes/${processId}/kill`, { signal });
			},
			async waitForPort(port: number, opts?: WaitForPortOptions): Promise<void> {
				await self.modal(`/v1/sandboxes/${self.id}/wait-for-port`, {
					port,
					mode: opts?.mode ?? 'http',
					path: opts?.path,
					timeout: opts?.timeout,
				});
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				return self.modal(`/v1/sandboxes/${self.id}/processes/${processId}/logs`);
			},
		};
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		// Modal returns a public tunnel URL for the exposed port — used directly by
		// the client, so the API's proxy() is a no-op for this backend.
		const res = await this.modal<{ url: string }>(`/v1/sandboxes/${this.id}/tunnels`, { port });
		return { url: res.url };
	}

	async destroy(): Promise<void> {
		await this.modal(`/v1/sandboxes/${this.id}/terminate`);
	}
}

export class ModalCompute implements SandboxProvider {
	constructor(private readonly config: ModalConfig) { }

	create(id: SandboxId): SandboxInstance {
		return new ModalSandboxInstance(id, this.config);
	}

	async proxy(_request: Request): Promise<Response | null> {
		// Modal kernels are reached directly via their public tunnel URL; nothing to
		// proxy at the control-plane edge.
		return null;
	}

	/**
	 * Enumerate the live Modal sandboxes this deployment owns, for the
	 * reconciler. SCOPED by app name so we never see (and never reap) co-tenant
	 * sandboxes sharing the Modal workspace.
	 *
	 * Contract (Part of the listActive port): the returned `id` must equal the
	 * `sandbox_id` stored on the session record. Our `sandbox_id` is the value we
	 * pass as the `{id}` path param to every Modal call, so the sandbox MUST be
	 * created/tagged with that id (e.g. a `marimohub_sandbox_id` label) for this
	 * matching to hold even if Modal assigns its own internal id.
	 *
	 * Request/response shapes are best-effort and the integration surface to
	 * validate against the live Modal API (see file header).
	 */
	async listActive(): Promise<ActiveSandbox[]> {
		const appName = this.config.appName ?? DEFAULT_APP_NAME;
		const res = await modalRequest<{
			sandboxes?: Array<{
				id?: string;
				sandbox_id?: string;
				created_at?: string;
				state?: string;
			}>;
		}>(this.config, `/v1/sandboxes/list?app_name=${encodeURIComponent(appName)}`, {
			method: 'GET',
		});

		const sandboxes = res.sandboxes ?? [];
		return (
			sandboxes
				// Only sandboxes Modal still considers live; terminated ones are not leaks.
				.filter((s) => s.state === undefined || s.state === 'running')
				.map((s) => ({ id: (s.sandbox_id ?? s.id ?? '') as SandboxId, createdAt: s.created_at }))
				.filter((s) => s.id !== '')
		);
	}
}
