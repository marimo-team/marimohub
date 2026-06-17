/**
 * The two built-in `SandboxExposure` strategies — pure URL shaping (no I/O beyond
 * HMAC). Request-time forwarding for `proxy` mode lives in the API/server tiers.
 */
import type {
	ExposureContext,
	ExposurePreparation,
	ExposureResult,
	SandboxExposure,
} from '../../ports/sandboxExposure';
import { signProxyToken } from './proxyToken';

/** Strip a single trailing slash so we can join path segments cleanly. */
function trimTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * `subdomain` (default) — the compute adapter's `exposePort()` URL is used as-is;
 * the browser reaches the kernel directly on its isolated domain. No proxying, no
 * marimo base path.
 */
export class SubdomainExposure implements SandboxExposure {
	readonly mode = 'subdomain' as const;

	async prepare(_ctx: ExposureContext): Promise<ExposurePreparation> {
		return {};
	}

	async finalize(exposedUrl: string, _ctx: ExposureContext): Promise<ExposureResult> {
		return { clientUrl: exposedUrl };
	}
}

/**
 * `proxy` — the kernel is reached through the app at `${appBaseUrl}/proxy/<token>/`.
 * `<token>` signs the session id (see `signProxyToken`); the same deterministic
 * token is used for both marimo's `--base-url` and the client URL, so the kernel's
 * own asset/websocket links resolve under the proxied prefix without response
 * rewriting. The compute adapter's `exposePort()` URL becomes the server-reachable
 * origin the forwarder targets.
 */
export class ProxyExposure implements SandboxExposure {
	readonly mode = 'proxy' as const;

	/** Public so the API's proxy forwarder can verify routing tokens with the same secret. */
	constructor(readonly signingSecret: string) {}

	private async pathFor(ctx: ExposureContext): Promise<string> {
		const token = await signProxyToken(ctx.projectId, ctx.sessionId, this.signingSecret);
		return `/proxy/${token}`;
	}

	async prepare(ctx: ExposureContext): Promise<ExposurePreparation> {
		return { baseUrl: await this.pathFor(ctx) };
	}

	async finalize(exposedUrl: string, ctx: ExposureContext): Promise<ExposureResult> {
		const path = await this.pathFor(ctx);
		return {
			clientUrl: `${trimTrailingSlash(ctx.appBaseUrl)}${path}/`,
			originUrl: exposedUrl,
		};
	}
}
