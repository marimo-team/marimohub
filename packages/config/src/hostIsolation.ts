import type { Env } from './env';

export interface SandboxHostIsolation {
	/** False only when both hosts are known AND they share an origin/parent domain. */
	isolated: boolean;
	sandboxHost?: string;
	appHost?: string;
}

/**
 * Pure check (no throw) reused by the wiring guard (index.ts) and the preflight
 * report. Returns `isolated: true` when there's nothing to compare (no sandbox
 * host, or no app host to derive from the OIDC redirect) — the wiring guard only
 * applies in `subdomain` mode, so a missing signal can't weaken `proxy` mode.
 *
 * Why this matters: notebook kernels run untrusted user code. If they share an
 * origin/parent domain with the control plane, a malicious notebook can escape the
 * iframe sandbox into the app or set cookies on the shared domain.
 */
export function checkSandboxHostIsolation(env: Env): SandboxHostIsolation {
	const sandboxHost = env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME?.trim().toLowerCase();
	if (!sandboxHost) return { isolated: true };
	const redirect = env.MARIMOHUB_AUTH_OIDC_REDIRECT_URI;
	if (!redirect) return { isolated: true, sandboxHost };
	let appHost: string;
	try {
		appHost = new URL(redirect).hostname.toLowerCase();
	} catch {
		return { isolated: true, sandboxHost };
	}
	const sameOrigin = sandboxHost === appHost;
	const sharesParent = sandboxHost.endsWith(`.${appHost}`) || appHost.endsWith(`.${sandboxHost}`);
	return { isolated: !(sameOrigin || sharesParent), sandboxHost, appHost };
}
