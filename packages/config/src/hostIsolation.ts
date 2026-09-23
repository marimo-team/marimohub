import { hostsOverlap, normalizeHostname } from '@marimo-hub/core/host-isolation';
import type { Env } from './env';

export interface SandboxHostIsolation {
	isolated: boolean;
	sandboxHost?: string;
	appHost?: string;
	/** Present only when isolation fails, so diagnostics distinguish overlap from invalid input. */
	reason?: 'shared-origin' | 'unverifiable-redirect' | 'invalid-sandbox-host';
}

/**
 * Sibling subdomains are supported for existing deployments.
 * A missing redirect leaves isolation unknown; a configured invalid host fails closed.
 */
export function checkSandboxHostIsolation(env: Env): SandboxHostIsolation {
	const sandboxHost = env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME?.trim().toLowerCase();
	if (!sandboxHost) return { isolated: true };
	try {
		normalizeHostname(sandboxHost);
	} catch {
		return { isolated: false, sandboxHost, reason: 'invalid-sandbox-host' };
	}
	const redirect = env.MARIMOHUB_AUTH_OIDC_REDIRECT_URI;
	if (!redirect) return { isolated: true, sandboxHost };
	let appHost: string;
	try {
		appHost = normalizeHostname(new URL(redirect).hostname);
	} catch {
		appHost = '';
	}
	if (!appHost) return { isolated: false, sandboxHost, reason: 'unverifiable-redirect' };

	if (hostsOverlap(sandboxHost, appHost)) {
		return { isolated: false, sandboxHost, appHost, reason: 'shared-origin' };
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

export function sandboxHostIsolationRemediation({ reason }: SandboxHostIsolation): string {
	switch (reason) {
		case 'unverifiable-redirect':
			return 'Set MARIMOHUB_AUTH_OIDC_REDIRECT_URI to a valid absolute http(s) redirect URI.';
		case 'invalid-sandbox-host':
			return 'Set MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME to a hostname with an optional port, without a scheme or path.';
		case 'shared-origin':
		case undefined:
			return 'Use a different sandbox hostname that is not a parent or subdomain of the app hostname.';
	}
}
