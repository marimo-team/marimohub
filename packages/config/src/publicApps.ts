import { DEFAULT_APP_POOL_POLICY, Millis } from '@marimo-hub/core';
import type { PublicAppsConfig } from '@marimo-hub/api';
import { parseBool, parseIntEnv, parseOnOff, parseSecondsEnv } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const MIN_SECRET_LENGTH = 32;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 10;
const DEFAULT_MAX_SESSIONS_PER_VERSION = 2;
const DEFAULT_MAX_VISITS_PER_SESSION = 25;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_LIFETIME_SECONDS = 3600;
const DEFAULT_VISIT_TOKEN_TTL_SECONDS = 600;

function positiveCap(env: Env, key: string, fallback: number): number {
	const value = parseIntEnv(env, key) ?? fallback;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ConfigError(
			`${key} must be a positive integer (unlimited is not allowed for public apps)`,
			{
				variable: key,
			},
		);
	}
	return value;
}

export function parsePublicAppsConfig(
	env: Env,
	context: { authBackend: string | undefined; exposureMode: 'subdomain' | 'proxy' },
): PublicAppsConfig | undefined {
	const enabled = parseOnOff(env, 'MARIMOHUB_PUBLIC_APP_LINKS', {
		fallback: false,
		docs: 'docs/apps.md',
	});
	if (!enabled) return undefined;

	const isIngressAuth =
		context.authBackend === 'proxy-header' || context.authBackend === 'cloudflare-access';
	if (isIngressAuth && context.exposureMode === 'proxy') {
		throw new ConfigError(
			`MARIMOHUB_PUBLIC_APP_LINKS=on cannot be combined with MARIMOHUB_AUTH_BACKEND=${context.authBackend} and MARIMOHUB_SANDBOX_EXPOSURE=proxy: bypassing ingress auth on /proxy/* would expose authenticated proxy sessions. Use MARIMOHUB_SANDBOX_EXPOSURE=subdomain or built-in OIDC auth.`,
			{ variable: 'MARIMOHUB_PUBLIC_APP_LINKS', docs: 'docs/security.md' },
		);
	}
	if (isIngressAuth && !parseBool(env, 'MARIMOHUB_PUBLIC_APPS_EDGE_BYPASS_ACK', false)) {
		throw new ConfigError(
			`MARIMOHUB_PUBLIC_APP_LINKS=on with MARIMOHUB_AUTH_BACKEND=${context.authBackend} requires MARIMOHUB_PUBLIC_APPS_EDGE_BYPASS_ACK=true after configuring ingress bypass rules for /app/*, /api/public/v1/*, /api/v1/theme, /manifest.webmanifest, /_marimo/*, and static assets (never /api/v1/* or /proxy/*).`,
			{ variable: 'MARIMOHUB_PUBLIC_APPS_EDGE_BYPASS_ACK', docs: 'docs/security.md' },
		);
	}

	const signingSecret =
		env.MARIMOHUB_PUBLIC_APPS_SECRET?.trim() || env.MARIMOHUB_AUTH_SESSION_SECRET?.trim();
	if (!signingSecret || signingSecret.length < MIN_SECRET_LENGTH) {
		throw new ConfigError(
			`MARIMOHUB_PUBLIC_APP_LINKS=on requires MARIMOHUB_PUBLIC_APPS_SECRET (or MARIMOHUB_AUTH_SESSION_SECRET) to be at least ${MIN_SECRET_LENGTH} characters.`,
			{ variable: 'MARIMOHUB_PUBLIC_APPS_SECRET', docs: 'docs/security.md' },
		);
	}

	const idleTimeoutMs = parseSecondsEnv(env, 'MARIMOHUB_PUBLIC_APPS_IDLE_TIMEOUT_SECONDS', {
		dflt: DEFAULT_IDLE_TIMEOUT_SECONDS,
	});
	const maxLifetimeMs = parseSecondsEnv(env, 'MARIMOHUB_PUBLIC_APPS_MAX_LIFETIME_SECONDS', {
		dflt: DEFAULT_MAX_LIFETIME_SECONDS,
	});
	const visitTokenTtlMs = parseSecondsEnv(env, 'MARIMOHUB_PUBLIC_APPS_VISIT_TOKEN_TTL_SECONDS', {
		dflt: DEFAULT_VISIT_TOKEN_TTL_SECONDS,
		max: 3600,
	});

	return {
		signingSecret,
		allowProjectIntegrations: parseOnOff(env, 'MARIMOHUB_PUBLIC_APPS_ALLOW_INTEGRATIONS', {
			fallback: false,
			docs: 'docs/apps.md',
		}),
		maxConcurrentSessions: positiveCap(
			env,
			'MARIMOHUB_PUBLIC_APPS_MAX_CONCURRENT_SESSIONS',
			DEFAULT_MAX_CONCURRENT_SESSIONS,
		),
		poolPolicy: {
			...DEFAULT_APP_POOL_POLICY,
			maxVisitsPerSession: positiveCap(
				env,
				'MARIMOHUB_PUBLIC_APPS_MAX_VISITS_PER_SESSION',
				DEFAULT_MAX_VISITS_PER_SESSION,
			),
			maxSessionsPerVersion: positiveCap(
				env,
				'MARIMOHUB_PUBLIC_APPS_MAX_SESSIONS_PER_VERSION',
				DEFAULT_MAX_SESSIONS_PER_VERSION,
			),
			idleMs: idleTimeoutMs,
		},
		idleTimeoutMs,
		maxLifetimeMs,
		visitTokenTtlSeconds: Millis.toSeconds(visitTokenTtlMs),
	};
}
