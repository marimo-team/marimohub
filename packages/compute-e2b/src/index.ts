/**
 * E2B compute backend — a `SandboxProvider` backed by E2B sandboxes (e2b.dev).
 *
 * E2B is purpose-built for exactly this: per-session sandboxes with a command +
 * filesystem API and a public per-port URL (`https://<port>-<id>.e2b.app`), so the
 * port methods map almost 1:1 and `proxy()` is a no-op (the SPA hits the kernel URL
 * directly).
 *
 * The `e2b` SDK is an OPTIONAL, bring-your-own dependency: it is NOT a hard
 * dependency of this package (kept out of the lockfile + the lean server image).
 * The adapter is written against the narrow {@link E2bClient} seam below — a fake
 * is injected in tests; production lazily `import()`s `e2b` via
 * {@link createE2bClient}, which throws a clear error if the SDK isn't installed.
 * To run this backend, `pnpm add e2b` and bake it into your server image.
 *
 * NOTE: the real-SDK wrapper in `createE2bClient` is the integration surface to
 * validate against the live E2B SDK (versions shift method shapes); the
 * fake-injected path is fully covered by tests.
 */
import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	parseFindFilesOutput,
	pollUntilReady,
	withEnvPrefix,
} from '@marimo-hub/compute-commons';
import { SandboxId, Seconds } from '@marimo-hub/core';
import type {
	ActiveSandbox,
	CreateSandboxOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	GitCheckoutOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';

/** Sandbox metadata key carrying OUR SandboxId (E2B assigns its own ids). */
const ID_META_KEY = 'mh-sandbox-id';
/** Metadata key marking sandboxes this deployment owns (for discovery/cleanup). */
const OWNER_META_KEY = 'mh-owner';
const DEFAULT_OWNER_TAG = 'marimohub';

// --- Injection seam: the slice of the E2B SDK this adapter uses --------------

export interface E2bExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Handle to a backgrounded command — used to stop the marimo kernel. */
export interface E2bCommandHandle {
	kill(): Promise<void>;
}

export interface E2bSandboxHandle {
	readonly sandboxId: string;
	commands: {
		run(
			cmd: string,
			options?: { cwd?: string; envs?: Record<string, string> },
		): Promise<E2bExecResult>;
		runBackground(
			cmd: string,
			options?: { cwd?: string; envs?: Record<string, string> },
		): Promise<E2bCommandHandle>;
	};
	files: {
		write(path: string, content: string | ArrayBuffer): Promise<void>;
		/** True multi-file write — one call for the whole set. */
		write(files: readonly { path: string; data: string | ArrayBuffer }[]): Promise<void>;
		read(path: string): Promise<string>;
	};
	/** Host (no scheme) the given container port is published at, e.g. `2718-<id>.e2b.app`. */
	getHost(port: number): string;
	kill(): Promise<void>;
}

/**
 * E2B's SDK takes an `ArrayBuffer`, not a `Uint8Array`. Slice to the view's own
 * range — passing `.buffer` straight through would send the whole backing buffer
 * whenever the caller handed us a subarray.
 */
function toE2bData(content: string | Uint8Array): string | ArrayBuffer {
	if (typeof content === 'string') return content;
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer;
}

export interface E2bSandboxInfo {
	sandboxId: string;
	startedAt?: string;
	metadata?: Record<string, string>;
}

export interface E2bClient {
	create(options: {
		template?: string;
		metadata?: Record<string, string>;
		timeoutMs?: number;
		envs?: Record<string, string>;
	}): Promise<E2bSandboxHandle>;
	connect(sandboxId: string): Promise<E2bSandboxHandle>;
	list(): Promise<E2bSandboxInfo[]>;
}

// --- Config -----------------------------------------------------------------

export interface E2bConfig {
	/** E2B API key (`E2B_API_KEY`). */
	apiKey: string;
	/** E2B template id with marimo + uv + python. Defaults to the SDK's base template. */
	template?: string;
	/** Custom E2B domain (self-hosted/enterprise); defaults to the SDK's `e2b.app`. */
	domain?: string;
	/** Tag stamped on every sandbox we own (metadata-based discovery/cleanup). Default `marimohub`. */
	ownerTag?: string;
	/** Hard cap on sandbox lifetime — E2B auto-kills past it. */
	maxLifetimeSeconds?: Seconds;
}

interface E2bSandboxState {
	handlePromise?: Promise<E2bSandboxHandle>;
	destroyPromise?: Promise<void>;
}

class E2bSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};

	constructor(
		private readonly id: SandboxId,
		private readonly config: E2bConfig,
		private readonly client: E2bClient,
		private readonly state: E2bSandboxState,
	) {}

	private get ownerTag(): string {
		return this.config.ownerTag ?? DEFAULT_OWNER_TAG;
	}

	private isOwned(info: E2bSandboxInfo): boolean {
		return (
			info.metadata?.[ID_META_KEY] === this.id && info.metadata?.[OWNER_META_KEY] === this.ownerTag
		);
	}

	/** Resolve the live E2B sandbox for our id: cached → reconnect-by-tag → create. */
	private ensure(): Promise<E2bSandboxHandle> {
		if (this.state.handlePromise) return this.state.handlePromise;
		const destroyPromise = this.state.destroyPromise;
		const promise = (async () => {
			if (destroyPromise) await destroyPromise;
			const existing = (await this.client.list()).find((sandbox) => this.isOwned(sandbox));
			if (existing) return this.client.connect(existing.sandboxId);
			return this.client.create({
				template: this.config.template,
				metadata: { [ID_META_KEY]: this.id, [OWNER_META_KEY]: this.ownerTag },
				...(this.config.maxLifetimeSeconds
					? { timeoutMs: Seconds.toMillis(this.config.maxLifetimeSeconds) }
					: {}),
			});
		})();
		this.state.handlePromise = promise;
		promise.catch(() => {
			if (this.state.handlePromise === promise) this.state.handlePromise = undefined;
		});
		return promise;
	}

	async exec(cmd: string): Promise<ExecResult> {
		const sb = await this.ensure();
		// Forced vars ride the SDK's per-command `envs`; defaults can't (that channel
		// always overwrites), so they go in as a guarded shell prefix instead.
		const res = await sb.commands.run(this.withDefaults(cmd), { envs: this.env });
		return execResult(res.exitCode === 0, res.stdout, res.stderr);
	}

	async execStream(cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		const res = await this.exec(cmd);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(res.stdout));
				controller.close();
			},
		});
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const sb = await this.ensure();
			const content = await sb.files.read(path);
			return { success: true, content, encoding: 'utf-8' };
		} catch {
			return readFileFailure('READ_FAILED');
		}
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		// The SDK filesystem API has no recursive list shape we rely on; shell out
		// via `find` (not on the provision/teardown hot path).
		const res = await this.exec(buildFindFilesCommand(path, options));
		if (!res.success) return listFilesFailure();
		return { success: true, files: parseFindFilesOutput(res.stdout, path, options) };
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const sb = await this.ensure();
		// E2B's SDK takes the whole set in one call (and creates parent dirs itself),
		// so a workspace restore is a single round-trip rather than one per file.
		await sb.files.write(files.map((f) => ({ path: f.path, data: toE2bData(f.content) })));
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
	}

	private withDefaults(cmd: string): string {
		return withEnvPrefix(cmd, {}, this.envDefaults);
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// No FUSE mount — throwing makes SandboxProvisioner fall back to copying
		// notebook files in/out (the intended path, like local/modal/coreweave).
		throw new Error('e2b compute uses file copy, not bucket mount');
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// No-op: nothing was mounted.
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const sb = await this.ensure();
		const logPath = '/tmp/marimohub-kernel.log';
		const handle = await sb.commands.runBackground(this.withDefaults(`${cmd} > ${logPath} 2>&1`), {
			envs: this.env,
			cwd: options?.cwd,
		});
		const exec = (c: string) => this.exec(c);
		const id = `e2b-proc-${sb.sandboxId}`;

		return {
			id,
			command: cmd,
			async kill(_signal?: string): Promise<void> {
				await handle.kill().catch(() => {});
			},
			async waitForPort(port: number, opts?: WaitForPortOptions): Promise<void> {
				const timeout = opts?.timeout ?? 30_000;
				// In-sandbox loopback probe (the SDK exposes no waitForPort), mirroring
				// the CoreWeave adapter. 0.0.0.0 binds include 127.0.0.1.
				const probe =
					`python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); ` +
					`sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)"`;
				await pollUntilReady(async () => (await exec(probe)).success, {
					timeoutMs: timeout,
					intervalMs: 500,
					timeoutMessage: async () =>
						`timed out waiting for port ${port} after ${timeout}ms.\n${(await exec(`cat ${logPath} 2>/dev/null || true`)).stdout}`,
				});
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				const logs = await exec(`cat ${logPath} 2>/dev/null || true`);
				return { stdout: logs.stdout, stderr: '' };
			},
		};
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		const sb = await this.ensure();
		return { url: `https://${sb.getHost(port)}` };
	}

	destroy(): Promise<void> {
		if (this.state.destroyPromise) return this.state.destroyPromise;

		const pending = this.state.handlePromise;
		this.state.handlePromise = undefined;
		const promise = (async () => {
			if (pending) {
				const cached = await pending.catch(() => null);
				if (cached) await cached.kill().catch(() => {});
			}
			// Reap duplicates left by provisioning races from older processes.
			const matches = (await this.client.list()).filter((sandbox) => this.isOwned(sandbox));
			for (const match of matches) {
				const handle = await this.client.connect(match.sandboxId).catch(() => null);
				if (handle) await handle.kill().catch(() => {});
			}
		})();
		this.state.destroyPromise = promise;
		const release = () => {
			if (this.state.destroyPromise === promise) this.state.destroyPromise = undefined;
		};
		void promise.then(release, release);
		return promise;
	}
}

export class E2bCompute implements SandboxProvider {
	private client?: E2bClient;
	private readonly sandboxStates = new Map<SandboxId, WeakRef<E2bSandboxState>>();
	private readonly sandboxStateFinalizer = new FinalizationRegistry<{
		id: SandboxId;
		ref: WeakRef<E2bSandboxState>;
	}>(({ id, ref }) => {
		if (this.sandboxStates.get(id) === ref) this.sandboxStates.delete(id);
	});

	constructor(
		private readonly config: E2bConfig,
		client?: E2bClient,
	) {
		this.client = client;
	}

	private getClient(): E2bClient {
		if (!this.client) this.client = createE2bClient(this.config);
		return this.client;
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		// For E2B the selectable "image" is a template id.
		const config = options?.image ? { ...this.config, template: options.image } : this.config;
		let ref = this.sandboxStates.get(id);
		let state = ref?.deref();
		if (!state) {
			state = {};
			ref = new WeakRef(state);
			this.sandboxStates.set(id, ref);
			this.sandboxStateFinalizer.register(state, { id, ref });
		}
		return new E2bSandboxInstance(id, config, this.getClient(), state);
	}

	async proxy(_request: Request): Promise<Response | null> {
		// E2B kernels are reached directly at https://<port>-<id>.e2b.app; nothing to proxy.
		return null;
	}

	async listActive(): Promise<ActiveSandbox[]> {
		const sandboxes = await this.getClient().list();
		const owner = this.config.ownerTag ?? DEFAULT_OWNER_TAG;
		const active: ActiveSandbox[] = [];
		for (const s of sandboxes) {
			// Only ours, and only those carrying our SandboxId (so the reconciler can
			// match a provider sandbox back to its session record).
			const ours = s.metadata?.[OWNER_META_KEY] === owner;
			const id = s.metadata?.[ID_META_KEY];
			// Drop anything not carrying a well-formed SandboxId: the reconciler keys
			// off our id, so a provider-native id could never match a session record.
			if (ours && SandboxId.is(id)) active.push({ id, createdAt: s.startedAt });
		}
		return active;
	}
}

/* oxlint-disable typescript/no-explicit-any -- the `e2b` SDK is an untyped, optional
   bring-your-own dependency loaded via runtime import(); `any` is the integration seam. */

/** The slice of the `e2b` SDK this client needs — just the `Sandbox` class. */
export interface E2bSdk {
	Sandbox: any;
}

/**
 * Default {@link E2bClient}: a thin wrapper over the real `e2b` SDK. By default the
 * SDK is loaded via a runtime `import()`, so it stays an optional, unbundled
 * dependency of the lean Node server image. Pass `loadSdk` to inject a
 * **statically-imported** SDK instead — required on runtimes that can't resolve a
 * dynamic `import()`, e.g. Cloudflare Workers, which must bundle every module (see
 * `deployment/cloudflare/src/e2b.ts`).
 *
 * INTEGRATION SURFACE — validate the SDK method shapes against the e2b version you
 * pin. Tracks e2b v2, which differs from v1 in two ways this wraps over:
 *   - `commands.run` THROWS `CommandExitError` on a non-zero exit; we catch it and
 *     return the result, because the port contract is a returned `ExecResult`
 *     (`exec` derives success from exitCode, and probes like `waitForPort` rely on
 *     a non-zero exit NOT throwing).
 *   - `Sandbox.list()` returns a paginator, not an array (see `drainSandboxList`).
 */
export function createE2bClient(
	config: E2bConfig,
	loadSdk: () => Promise<E2bSdk> = defaultLoadSdk,
): E2bClient {
	const common = { apiKey: config.apiKey, ...(config.domain ? { domain: config.domain } : {}) };

	const wrap = (sbx: any): E2bSandboxHandle => ({
		sandboxId: sbx.sandboxId,
		commands: {
			async run(cmd, options) {
				try {
					const r = await sbx.commands.run(cmd, { ...options });
					return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
				} catch (err) {
					// e2b throws CommandExitError on a non-zero exit; surface it as a result
					// (the error carries stdout/stderr/exitCode). Anything else is a real fault.
					const e = err as { exitCode?: number; stdout?: string; stderr?: string };
					if (e && typeof e.exitCode === 'number') {
						return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.exitCode };
					}
					throw err;
				}
			},
			async runBackground(cmd, options) {
				const h = await sbx.commands.run(cmd, { ...options, background: true });
				return { kill: async () => void (await sbx.commands.kill?.(h.pid).catch(() => {})) };
			},
		},
		files: {
			write: async (
				pathOrFiles: string | readonly { path: string; data: string | ArrayBuffer }[],
				content?: string | ArrayBuffer,
			) =>
				void (typeof pathOrFiles === 'string'
					? await sbx.files.write(pathOrFiles, content!)
					: await sbx.files.write([...pathOrFiles])),
			read: (path) => sbx.files.read(path),
		},
		getHost: (port) => sbx.getHost(port),
		kill: async () => void (await sbx.kill()),
	});

	return {
		async create(options) {
			const { Sandbox } = await loadSdk();
			const sbx = await Sandbox.create(config.template, {
				...common,
				...(options.metadata ? { metadata: options.metadata } : {}),
				...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
				...(options.envs ? { envs: options.envs } : {}),
			});
			return wrap(sbx);
		},
		async connect(sandboxId) {
			const { Sandbox } = await loadSdk();
			return wrap(await Sandbox.connect(sandboxId, common));
		},
		async list() {
			const { Sandbox } = await loadSdk();
			const infos = await drainSandboxList(Sandbox.list(common));
			return infos.map((i: any) => ({
				sandboxId: i.sandboxId,
				startedAt: i.startedAt instanceof Date ? i.startedAt.toISOString() : i.startedAt,
				metadata: i.metadata,
			}));
		},
	};
}

/** Default SDK loader: a runtime `import('e2b')`, left unbundled for the Node image. */
async function defaultLoadSdk(): Promise<E2bSdk> {
	// Computed specifier + @vite-ignore so the bundler leaves this as a runtime import.
	const moduleName = 'e2b';
	try {
		return (await import(/* @vite-ignore */ moduleName)) as E2bSdk;
	} catch (err) {
		throw new Error(
			"MARIMOHUB_COMPUTE_BACKEND=e2b requires the 'e2b' SDK. Run `pnpm add e2b` and bake it into " +
				"the server image, or inject it via createE2bClient's `loadSdk` on runtimes that can't " +
				`dynamically import (e.g. Cloudflare Workers). (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

/**
 * Flatten `Sandbox.list()` to an array. e2b v2 returns a paginator
 * (`hasNext`/`nextItems`); older versions returned a promise of an array — support
 * both so the client isn't pinned to one SDK major.
 */
async function drainSandboxList(result: any): Promise<any[]> {
	if (result && typeof result.nextItems === 'function') {
		const items: any[] = [];
		while (result.hasNext) items.push(...(await result.nextItems()));
		return items;
	}
	return (await result) ?? [];
}
/* oxlint-enable typescript/no-explicit-any */
