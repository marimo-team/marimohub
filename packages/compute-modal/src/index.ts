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
import { FetchError, ofetch } from 'ofetch';
import { buildGitCloneCommand } from '@marimo-hub/compute-commons';
import { SandboxId } from '@marimo-hub/core';
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
 * Timeout for short control-plane calls so a stuck Modal request can't hang
 * provisioning. Variable-length calls (exec, wait-for-port, streams) pass
 * `timeout: 0` to opt out — they legitimately block for a long time.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Modal auth headers, shared by every request. */
function modalHeaders(config: ModalConfig): Record<string, string> {
	return { 'Modal-Key': config.tokenId, 'Modal-Secret': config.tokenSecret };
}

/** Re-wrap an `ofetch` FetchError into the adapter's existing message shape. */
function toModalError(err: unknown, path: string): Error {
	if (err instanceof FetchError && err.response) {
		const body = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '');
		return new Error(`Modal API ${path} failed: ${err.status} ${body}`);
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * Authenticated request to Modal's API via `ofetch`. ofetch adds a request
 * timeout (default {@link DEFAULT_TIMEOUT_MS}; pass `timeout: 0` to disable) and,
 * for idempotent reads, an opt-in retry on transient 5xx/429 — while handling
 * JSON (de)serialization and non-2xx throwing. We re-wrap its FetchError into the
 * adapter's existing message shape. Endpoints/shapes are the integration surface
 * to validate against the live API (see file header). Shared by the per-sandbox
 * instance and the provider-level `listActive()`.
 *
 * NOTE: Modal exec/startProcess RUN a command, so retry defaults to 0 (replaying
 * is not idempotent); only read-only calls opt into retry.
 */
async function modalRequest<T>(
	config: ModalConfig,
	path: string,
	options?: { method?: string; body?: unknown; timeout?: number; retry?: number },
): Promise<T> {
	try {
		return await ofetch<T>(path, {
			baseURL: config.apiBase ?? DEFAULT_API_BASE,
			method: options?.method ?? 'POST',
			headers: modalHeaders(config),
			body: options?.body as Record<string, unknown> | undefined,
			// Modal always answers JSON; parse it regardless of the content-type header
			// (matches the old `res.json()`).
			responseType: 'json',
			timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
			retry: options?.retry ?? 0,
			retryDelay: 250,
			retryStatusCodes: [429, 500, 502, 503, 504],
		});
	} catch (err) {
		throw toModalError(err, path);
	}
}

class ModalSandboxInstance implements SandboxInstance {
	constructor(
		private readonly id: SandboxId,
		private readonly config: ModalConfig,
	) {}

	private get apiBase(): string {
		return this.config.apiBase ?? DEFAULT_API_BASE;
	}

	/** Authenticated POST to Modal's API. Endpoints are the integration surface. */
	private modal<T>(
		path: string,
		body?: unknown,
		opts?: { timeout?: number; retry?: number },
	): Promise<T> {
		return modalRequest<T>(this.config, path, { body, ...opts });
	}

	async exec(cmd: string): Promise<ExecResult> {
		// An exec can run arbitrarily long (installs, clones); opt out of the
		// control-plane timeout so a slow-but-healthy command isn't aborted.
		const res = await this.modal<{ exit_code: number; stdout: string; stderr: string }>(
			`/v1/sandboxes/${this.id}/exec`,
			{ command: ['sh', '-lc', cmd] },
			{ timeout: 0 },
		);
		return { success: res.exit_code === 0, stdout: res.stdout, stderr: res.stderr };
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		// A streamed exec stays open indefinitely (e.g. `tail -f`), so no timeout
		// and no retry — just ofetch's stream response type + error normalization.
		// Let ofetch infer the response type from `responseType: 'stream'` (returns
		// the ReadableStream body, or undefined when there is none).
		let stream: ReadableStream<Uint8Array> | undefined;
		try {
			stream = await ofetch(`/v1/sandboxes/${this.id}/exec?stream=1`, {
				baseURL: this.apiBase,
				method: 'POST',
				headers: modalHeaders(this.config),
				body: { command: ['sh', '-lc', cmd] },
				responseType: 'stream',
				timeout: 0,
				retry: 0,
			});
		} catch (err) {
			if (err instanceof FetchError) {
				throw new Error(`Modal exec stream failed: ${err.status ?? ''}`.trimEnd());
			}
			throw err;
		}
		if (!stream) {
			throw new Error('Modal exec stream failed: no response body');
		}
		return stream;
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
		// shellQuote'd args (via buildGitCloneCommand) close the injection hole the
		// previous raw interpolation left open; throw on failure like every other adapter.
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
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
		return {
			id: processId,
			command: cmd,
			kill: async (signal?: string): Promise<void> => {
				await this.modal(`/v1/sandboxes/${this.id}/processes/${processId}/kill`, { signal });
			},
			waitForPort: async (port: number, opts?: WaitForPortOptions): Promise<void> => {
				// This call blocks until the port is ready (or Modal's own timeout), so
				// opt out of the control-plane HTTP timeout.
				await this.modal(
					`/v1/sandboxes/${this.id}/wait-for-port`,
					{
						port,
						mode: opts?.mode ?? 'http',
						path: opts?.path,
						timeout: opts?.timeout,
					},
					{ timeout: 0 },
				);
			},
			getLogs: async (): Promise<{ stdout: string; stderr: string }> => {
				return this.modal(`/v1/sandboxes/${this.id}/processes/${processId}/logs`);
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
	constructor(private readonly config: ModalConfig) {}

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
			sandboxes?: {
				id?: string;
				sandbox_id?: string;
				created_at?: string;
				state?: string;
			}[];
		}>(this.config, `/v1/sandboxes/list?app_name=${encodeURIComponent(appName)}`, {
			method: 'GET',
			// Idempotent read — safe to retry on a transient blip.
			retry: 2,
		});

		const active: ActiveSandbox[] = [];
		for (const s of res.sandboxes ?? []) {
			// Only sandboxes Modal still considers live; terminated ones are not leaks.
			if (s.state !== undefined && s.state !== 'running') continue;
			// The id must be our SandboxId (see contract above): a non-conforming or
			// empty value could never match a session record, so drop it.
			const id = s.sandbox_id ?? s.id ?? '';
			if (SandboxId.is(id)) active.push({ id, createdAt: s.created_at });
		}
		return active;
	}
}
