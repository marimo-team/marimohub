/**
 * OPT-IN: `TieredComputeProvider` — a `SandboxProvider` that runs kernels on E2B
 * (primary) and transparently falls back to Cloudflare Sandboxes (secondary) when
 * E2B is unreachable. Kept out of the main library on purpose: it's a composition
 * detail of an entrypoint that happens to wire two backends, not a port every
 * entrypoint needs. E2B and Cloudflare are otherwise independent compute ports.
 *
 * The two providers have different shapes, so the tiering is per-method, not a
 * blanket "try A then B":
 *
 *   - create()      → FALLBACK. Each sandbox is pinned to ONE backend, chosen once
 *                     on first use (see {@link TieredSandboxInstance}). Mixing a
 *                     session's ops across backends would split-brain it, so we pick
 *                     a backend and stick to it — never per-operation failover.
 *   - listActive()  → FEDERATED. Union of every backend that can enumerate. Only
 *                     E2B can (Cloudflare sandboxes are Durable-Object-addressed and
 *                     un-enumerable), so in practice this reports E2B truth. See the
 *                     caveat on {@link TieredComputeProvider.listActive}.
 *   - proxy()       → FEDERATED. Try each backend; first non-null wins. E2B kernels
 *                     are hit directly (its proxy is a no-op), so this is effectively
 *                     Cloudflare's subdomain proxy for any CF-hosted kernel.
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
	SandboxFileWrite,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	SetEnvVarsOptions,
	StartProcessOptions,
} from '@marimo-hub/core/ports';
import type { SandboxId } from '@marimo-hub/core';

class TieredSandboxInstance implements SandboxInstance {
	/** Memoised backend choice — resolved once, then every op routes to it. */
	private backend?: Promise<SandboxInstance>;
	/** The settled backend, once {@link pick} completes, so sync reads can see it. */
	private resolved?: SandboxInstance;

	/**
	 * Reflects the pinned backend's capability (E2B false, Cloudflare true).
	 * `undefined` until the backend is chosen, which keeps the provisioner on its
	 * legacy try-mount-then-copy path; by the mount step the provisioner has
	 * already exec'd against the sandbox, so the backend is always pinned.
	 */
	get supportsBucketMount(): boolean | undefined {
		return this.resolved?.supportsBucketMount;
	}

	constructor(
		private readonly id: SandboxId,
		private readonly primary: SandboxProvider,
		private readonly secondary: SandboxProvider,
	) {}

	/**
	 * Choose the backend this sandbox lives on, exactly once, and stick to it.
	 *
	 * The probe is a single non-creating call — `primary.listActive()` — which
	 * answers "is E2B reachable?": if it returns, E2B is our backend (it reconnects
	 * to an existing sandbox by id, or creates a new one there); if it throws, E2B
	 * is down and we fall back to Cloudflare.
	 *
	 * Known gap: an *existing Cloudflare* sandbox reconnected while E2B is back up
	 * looks identical to a brand-new sandbox (Cloudflare can't be enumerated to say
	 * otherwise), so it mis-routes to E2B. Cloudflare sandboxes only exist during an
	 * E2B outage and self-expire (`sleepAfter`), so we accept that over paying a
	 * probe on every reconnect.
	 */
	private resolve(): Promise<SandboxInstance> {
		if (!this.backend) {
			this.backend = this.pick().then((backend) => {
				this.resolved = backend;
				return backend;
			});
		}
		return this.backend;
	}

	private async pick(): Promise<SandboxInstance> {
		try {
			// Non-creating reachability probe. Absent a listActive we can't detect an
			// outage, so we'd never fail over — but the primary (E2B) always has one.
			if (this.primary.listActive) await this.primary.listActive();
			return this.primary.create(this.id);
		} catch (err) {
			// Never silent: a fallback usually means E2B is genuinely down, but a bad
			// E2B_API_KEY (401) or misconfig looks identical, so surface the real cause.
			console.error(
				`[tieredCompute] E2B probe failed for sandbox ${this.id}; using Cloudflare Sandbox fallback:`,
				err instanceof Error ? (err.stack ?? err.message) : String(err),
			);
			return this.secondary.create(this.id);
		}
	}

	async exec(cmd: string): Promise<ExecResult> {
		return (await this.resolve()).exec(cmd);
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		return (await this.resolve()).execStream(cmd, options);
	}

	async readFile(path: string): Promise<ReadFileResult> {
		return (await this.resolve()).readFile(path);
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		return (await this.resolve()).listFiles(path, options);
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		return (await this.resolve()).writeFiles(files);
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		return (await this.resolve()).gitCheckout(repo, options);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		return (await this.resolve()).setEnvVars(vars, options);
	}

	async mountBucket(options: MountBucketOptions): Promise<void> {
		// Delegated as-is: on E2B this throws by design (→ provisioner copies files);
		// on Cloudflare it mounts R2. Routing is already pinned by the time the
		// provisioner reaches this step (it execs `true` first), so the throw can't
		// be mistaken for an E2B outage.
		return (await this.resolve()).mountBucket(options);
	}

	async unmountBucket(mountPath: string): Promise<void> {
		return (await this.resolve()).unmountBucket(mountPath);
	}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		return (await this.resolve()).startProcess(cmd, options);
	}

	async exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult> {
		return (await this.resolve()).exposePort(port, options);
	}

	async destroy(): Promise<void> {
		return (await this.resolve()).destroy();
	}
}

export class TieredComputeProvider implements SandboxProvider {
	/**
	 * @param primary   E2B — preferred backend.
	 * @param secondary Cloudflare Sandboxes — fallback when E2B is unreachable.
	 */
	constructor(
		private readonly primary: SandboxProvider,
		private readonly secondary: SandboxProvider,
	) {}

	create(id: SandboxId): SandboxInstance {
		return new TieredSandboxInstance(id, this.primary, this.secondary);
	}

	async proxy(request: Request): Promise<Response | null> {
		return (await this.primary.proxy(request)) ?? (await this.secondary.proxy(request));
	}

	/**
	 * Union of the backends that can enumerate their sandboxes. Cloudflare cannot
	 * (Durable Objects aren't listable), so this reports E2B truth — which is
	 * complete in steady state, since every sandbox lives on E2B unless E2B was down
	 * when it was provisioned. Caveat: during that fallback window a live
	 * Cloudflare-hosted session is invisible here, so the reconciler's "record is
	 * live but sandbox is gone" rule may mark it failed early; Cloudflare's
	 * `sleepAfter` still reaps the sandbox itself.
	 */
	async listActive(): Promise<ActiveSandbox[]> {
		const lists = await Promise.all(
			[this.primary, this.secondary].map((p) =>
				p.listActive ? p.listActive() : Promise.resolve<ActiveSandbox[]>([]),
			),
		);
		const seen = new Set<string>();
		const merged: ActiveSandbox[] = [];
		for (const list of lists) {
			for (const sandbox of list) {
				if (seen.has(sandbox.id)) continue;
				seen.add(sandbox.id);
				merged.push(sandbox);
			}
		}
		return merged;
	}
}
