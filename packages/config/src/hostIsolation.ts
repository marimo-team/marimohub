import { hostsShareCookieDomain } from '@marimo-hub/core/host-isolation';
import type { Env } from './env';

export interface SandboxHostIsolation {
	/** False when the hosts share an origin/parent domain OR isolation can't be verified. */
	isolated: boolean;
	sandboxHost?: string;
	appHost?: string;
	/** Present only when isolation fails, so diagnostics distinguish overlap from invalid input. */
	reason?: 'shared-origin' | 'unverifiable-redirect' | 'invalid-sandbox-host';
}

/**
 * Pure check (no throw) reused by the wiring guard (index.ts) and the preflight
 * report. Returns `isolated: true` when there's nothing to compare (no sandbox
 * host, or no redirect at all to derive an app host from) — the wiring guard only
 * applies in `subdomain` mode, so a missing signal can't weaken `proxy` mode. But
 * a redirect that IS set yet unparseable fails closed (`isolated: false`): the app
 * host is then unknowable and isolation can't be verified.
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
		appHost = '';
	}
	// A redirect WAS configured but yields no usable app host — either unparseable,
	// or a hostless scheme like `mailto:` (empty hostname). Isolation can't be
	// verified, so fail closed: a bad redirect must not silently green-light a
	// potentially same-origin untrusted kernel.
	if (!appHost) return { isolated: false, sandboxHost, reason: 'unverifiable-redirect' };

	try {
		if (hostsShareCookieDomain(sandboxHost, appHost)) {
			return { isolated: false, sandboxHost, appHost, reason: 'shared-origin' };
		}
	} catch {
		return { isolated: false, sandboxHost, appHost, reason: 'invalid-sandbox-host' };
	}
	return { isolated: true, sandboxHost, appHost };
}

export function sandboxHostIsolationMessage({
	sandboxHost,
	appHost,
	reason,
}: SandboxHostIsolation): string {
	switch (reason) {
		case 'unverifiable-redirect':
			return (
				'MARIMOHUB_AUTH_OIDC_REDIRECT_URI does not yield a usable app host, so isolation of ' +
				`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (${sandboxHost}) cannot be verified. Set a valid ` +
				'absolute http(s) redirect URI.'
			);
		case 'invalid-sandbox-host':
			return `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (${sandboxHost}) is not a valid hostname, so isolation cannot be verified.`;
		case 'shared-origin':
		case undefined:
			return (
				`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (${sandboxHost}) shares an origin/parent domain with the ` +
				`app host (${appHost}).`
			);
	}
}
