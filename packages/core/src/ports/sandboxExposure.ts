import type { NotebookId, ProjectId, SandboxId, SessionId } from '../ids';

/**
 * How a running kernel is surfaced to the browser. Chosen globally per deployment
 * (config: `MARIMOHUB_SANDBOX_EXPOSURE`) and applied agnostic of the compute
 * backend:
 *
 * - `subdomain` — the kernel is reached DIRECTLY at the compute adapter's public
 *   URL on an isolated sandbox domain (`<id>.sandbox.example.com`). True
 *   cross-origin isolation; not authenticated by the hub (the unguessable sandbox
 *   id is the capability). The default mode.
 * - `proxy` — all kernel traffic is forwarded THROUGH the app at
 *   `…/proxy/<token>/…`, so it passes through the hub's auth + per-session
 *   authorization. Same-origin with the app (XSS-capable); for trusted
 *   deployments only, gated behind an explicit opt-in.
 */
export type SandboxExposureMode = 'subdomain' | 'proxy';

/** Everything an exposure needs to shape a session's URLs. */
export interface ExposureContext {
	sessionId: SessionId;
	projectId: ProjectId;
	notebookId: NotebookId;
	sandboxId: SandboxId;
	/** The app's public origin (e.g. `https://hub.example.com`), no trailing slash. */
	appBaseUrl: string;
}

export interface ExposurePreparation {
	/**
	 * Base path marimo serves under (`--base-url`), so its asset/websocket URLs
	 * resolve beneath the proxied prefix. Undefined in `subdomain` mode (the kernel
	 * serves at root).
	 */
	baseUrl?: string;
}

export interface ExposureResult {
	/** URL the browser loads in the iframe (persisted as `session.sandbox_url`). */
	clientUrl: string;
	/**
	 * Server-reachable kernel endpoint to persist as `session.sandbox_origin_url`
	 * for the forwarder. Undefined in `subdomain` mode (no proxying).
	 */
	originUrl?: string;
}

/**
 * Render-mode strategy that sits ABOVE the compute provider. The session route
 * calls `prepare()` before launching marimo (to pick a `--base-url`) and
 * `finalize()` after `exposePort()` returns the kernel's reachable URL (to derive
 * the client-facing URL). The request-time forwarding for `proxy` mode lives in
 * the API/server tiers (it needs the authenticator + session store); this port
 * only owns the vendor-free URL shaping.
 */
export interface SandboxExposure {
	readonly mode: SandboxExposureMode;
	prepare(ctx: ExposureContext): Promise<ExposurePreparation>;
	finalize(exposedUrl: string, ctx: ExposureContext): Promise<ExposureResult>;
}
