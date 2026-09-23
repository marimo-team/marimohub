import { hostsOverlap, normalizeHostname } from '@marimo-hub/core/host-isolation';
import type { Env } from './env';

export interface SandboxHostIsolation {
	isolated: boolean;
	sandboxHost?: string;
	appHost?: string;
	/** Present only when isolation fails, so diagnostics distinguish overlap from invalid input. */
	reason?:
		| 'shared-origin'
		| 'unverifiable-redirect'
		| 'invalid-sandbox-host'
		| 'unverifiable-origin'
		| 'conflicting-origins';
}

/**
 * Sibling subdomains are supported; missing or invalid app origins fail closed.
 */
export function checkSandboxHostIsolation(env: Env): SandboxHostIsolation {
	const sandboxHost = env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME?.trim().toLowerCase();
	if (!sandboxHost) return { isolated: true };
	try {
		const hostname = normalizeHostname(sandboxHost);
		if (!hostname || /^\.+$/.test(hostname)) throw new Error('Invalid sandbox hostname');
	} catch {
		return { isolated: false, sandboxHost, reason: 'invalid-sandbox-host' };
	}
	const appUrl = env.MARIMOHUB_APP_BASE_URL;
	const redirect = env.MARIMOHUB_AUTH_OIDC_REDIRECT_URI;
	if (!appUrl && !redirect) {
		return { isolated: false, sandboxHost, reason: 'unverifiable-origin' };
	}
	const app = parseAppOrigin(appUrl);
	if (appUrl !== undefined && !app) {
		return { isolated: false, sandboxHost, reason: 'unverifiable-origin' };
	}
	const callback = parseAppOrigin(redirect);
	if (redirect !== undefined && !callback) {
		return { isolated: false, sandboxHost, reason: 'unverifiable-redirect' };
	}
	if (app && callback && app.origin !== callback.origin) {
		return { isolated: false, sandboxHost, reason: 'conflicting-origins' };
	}
	const appHost = normalizeHostname((app ?? callback)!.hostname);

	if (hostsOverlap(sandboxHost, appHost)) {
		return { isolated: false, sandboxHost, appHost, reason: 'shared-origin' };
	}
	return { isolated: true, sandboxHost, appHost };
}

function parseAppOrigin(value: string | undefined): URL | undefined {
	if (value === undefined || !/^https?:\/\/[^/\\]/i.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
			return undefined;
		const hostname = normalizeHostname(url.hostname);
		if (!hostname || /^\.+$/.test(hostname)) return undefined;
		return url;
	} catch {
		return undefined;
	}
}

export function sandboxHostIsolationMessage({
	sandboxHost,
	appHost,
	reason,
}: SandboxHostIsolation): string {
	switch (reason) {
		case 'unverifiable-origin':
		case 'conflicting-origins':
			return sandboxHostIsolationRemediation({ reason });
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

export function sandboxHostIsolationRemediation({
	reason,
}: Pick<SandboxHostIsolation, 'reason'>): string {
	switch (reason) {
		case 'unverifiable-origin':
			return 'Set MARIMOHUB_APP_BASE_URL or MARIMOHUB_AUTH_OIDC_REDIRECT_URI to a valid absolute http(s) URL. Both must have the same origin when present.';
		case 'conflicting-origins':
			return 'MARIMOHUB_APP_BASE_URL and MARIMOHUB_AUTH_OIDC_REDIRECT_URI must have the same origin.';
		case 'unverifiable-redirect':
			return 'Set MARIMOHUB_AUTH_OIDC_REDIRECT_URI to a valid absolute http(s) redirect URI.';
		case 'invalid-sandbox-host':
			return 'Set MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME to a hostname with an optional port, without a scheme or path.';
		case 'shared-origin':
		case undefined:
			return 'Use a different sandbox hostname that is not a parent or subdomain of the app hostname.';
	}
}
