/**
 * Configuration composition root.
 *
 * `createFromEnv()` reads the `MARIMOHUB_*` environment, selects an adapter per
 * `*_BACKEND` selector, and returns the wired `ApiDeps` that `createApi` consumes.
 * This is the ONLY package that imports concrete adapters, so the dependency
 * graph still points inward (core/api never import it). The per-subsystem
 * factories live in `./storage`, `./compute`, `./auth`, and `./wif`; this file
 * only assembles them and parses the server-wide policy knobs.
 *
 * The `r2` / `cloudflare` / `cloudflare-access` selectors are Workers-only (they
 * need platform bindings, not env credentials) and are wired by hand in
 * examples/cloudflare-worker rather than here.
 */
import {
	composeAuthenticators,
	createServices,
	Millis,
	ProxyExposure,
	runPreflight,
	SubdomainExposure,
	VIEWER_MODES,
} from '@marimo-hub/core';
import type { Metrics, Role, SandboxExposure, ViewerMode } from '@marimo-hub/core';
import type { ApiDeps, SessionLifetimeConfig } from '@marimo-hub/api';
import { makeAi } from './ai';
import { makeAuth } from './auth';
import { makeCompute, resolveSandboxImages } from './compute';
import { makeSecrets } from './secrets';
import { makeStorage, makeSandboxBucketConfig } from './storage';
import { makeWif } from './wif';
import { parseIntEnv, parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import { checkSandboxHostIsolation } from './hostIsolation';
import { buildPreflightChecks } from './preflightChecks';

export { ConfigError, isConfigError } from './errors';
export type { ConfigErrorOptions } from './errors';

/**
 * When this process started, captured once at module load. Surfaced by
 * `GET /api/v1/version` so the UI can show when the pod last (re)started — distinct
 * from the image's build time.
 */
const PROCESS_STARTED_AT = new Date().toISOString();

/** Default concurrent-session cap per user when unset (a cost-DoS guard). */
const DEFAULT_MAX_SESSIONS_PER_USER = 10;

/** Parse the per-user concurrent-session cap. `0` disables the cap (unlimited). */
function parseSessionCap(env: Env): number | undefined {
	const raw = env.MARIMOHUB_MAX_SESSIONS_PER_USER;
	// Empty means unset, NOT `Number('') === 0` (which would silently disable the cap).
	if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_SESSIONS_PER_USER;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new ConfigError(
			`Invalid MARIMOHUB_MAX_SESSIONS_PER_USER: ${raw} (expected a non-negative integer)`,
			{
				variable: 'MARIMOHUB_MAX_SESSIONS_PER_USER',
				remediation: 'Use 0 (unlimited) or a positive integer.',
			},
		);
	}
	return n === 0 ? undefined : n;
}

/** Default per-project concurrent app (`run`) session cap when unset. */
const DEFAULT_MAX_APPS_PER_PROJECT = 5;

/** Parse the per-project app cap. `0` disables the cap (unlimited). */
function parseAppCap(env: Env): number | undefined {
	const raw = env.MARIMOHUB_MAX_APPS_PER_PROJECT;
	// Empty means unset, NOT `Number('') === 0` (which would silently disable the cap).
	if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_APPS_PER_PROJECT;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new ConfigError(
			`Invalid MARIMOHUB_MAX_APPS_PER_PROJECT: ${raw} (expected a non-negative integer)`,
			{
				variable: 'MARIMOHUB_MAX_APPS_PER_PROJECT',
				remediation: 'Use 0 (unlimited) or a positive integer.',
			},
		);
	}
	return n === 0 ? undefined : n;
}

/** Session-lifecycle defaults (seconds). See docs/configuration.md#server--api. */
const DEFAULT_SESSION_MAX_LIFETIME_S = 14400; // 4h graceful lifetime
const DEFAULT_SESSION_IDLE_TIMEOUT_S = 1800; // 30m no-editors idle reap
const DEFAULT_SESSION_SNAPSHOT_INTERVAL_S = 120; // 2m periodic-save floor
const DEFAULT_SESSION_LIFETIME_EXTENSION_S = 1800; // 30m slide while editors connected
const DEFAULT_SESSION_SWEEP_INTERVAL_S = 60;

/**
 * Parse the marimohub-owned session lifetime policy: the graceful TTL enforced
 * by the lifecycle sweep, the idle timeout, the periodic snapshot cadence, and
 * connection-awareness. All optional with safe defaults; snapshot interval `0`
 * disables periodic snapshots.
 */
function parseSessionLifetime(env: Env): SessionLifetimeConfig {
	const seconds = (key: string, dflt: number, opts?: { allowZero?: boolean }) => {
		const n = parseIntEnv(env, key) ?? dflt;
		const min = opts?.allowZero ? 0 : 1;
		if (n < min) {
			throw new ConfigError(`Invalid ${key}: ${n} (expected an integer >= ${min})`, {
				variable: key,
			});
		}
		return Millis.seconds(n);
	};
	return {
		maxLifetimeMs: seconds(
			'MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS',
			DEFAULT_SESSION_MAX_LIFETIME_S,
		),
		idleTimeoutMs: seconds(
			'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS',
			DEFAULT_SESSION_IDLE_TIMEOUT_S,
		),
		snapshotIntervalMs: seconds(
			'MARIMOHUB_SESSION_SNAPSHOT_INTERVAL_SECONDS',
			DEFAULT_SESSION_SNAPSHOT_INTERVAL_S,
			{ allowZero: true },
		),
		extensionMs: seconds(
			'MARIMOHUB_SESSION_LIFETIME_EXTENSION_SECONDS',
			DEFAULT_SESSION_LIFETIME_EXTENSION_S,
		),
		connectionAware: env.MARIMOHUB_SESSION_CONNECTION_AWARE !== 'false',
		sweepIntervalMs: seconds(
			'MARIMOHUB_SESSION_SWEEP_INTERVAL_SECONDS',
			DEFAULT_SESSION_SWEEP_INTERVAL_S,
		),
	};
}

/**
 * The fallback role granted to any logged-in user who is not the project owner
 * or an explicit member. Defaults to `editor` so a logged-in user can edit
 * notebooks out of the box; set `none` (or `viewer`) to keep writes
 * members-only. Project edit/delete always requires `admin`, so even `editor`
 * here cannot reach it.
 */
function parseDefaultRole(env: Env): Role | undefined {
	const raw = env.MARIMOHUB_DEFAULT_ROLE?.trim().toLowerCase();
	if (raw === undefined || raw === '') return 'editor';
	if (raw === 'none') return undefined;
	if (raw === 'viewer' || raw === 'editor' || raw === 'admin') return raw;
	throw new ConfigError(
		`Invalid MARIMOHUB_DEFAULT_ROLE: ${env.MARIMOHUB_DEFAULT_ROLE} (expected viewer, editor, admin, or none)`,
		{ variable: 'MARIMOHUB_DEFAULT_ROLE' },
	);
}

/**
 * What an effective `viewer` gets, each tier a superset of the last. `static`
 * (the default) serves the last captured HTML snapshot — no compute, no code
 * execution; `applications` also admits viewers to the shared notebook app;
 * `ephemeral-sandbox` additionally provisions a real edit kernel whose session
 * is never written back. Throws on any other value.
 */
function parseViewerMode(env: Env): ViewerMode {
	const raw = env.MARIMOHUB_VIEWER_MODE?.trim().toLowerCase();
	if (raw === undefined || raw === '') return 'static';
	if ((VIEWER_MODES as readonly string[]).includes(raw)) return raw as ViewerMode;
	throw new ConfigError(
		`Invalid MARIMOHUB_VIEWER_MODE: ${env.MARIMOHUB_VIEWER_MODE} (expected ${VIEWER_MODES.join(', ')})`,
		{ variable: 'MARIMOHUB_VIEWER_MODE' },
	);
}

/**
 * Which sandbox working-dir files survive a session. `source` (the default)
 * persists only the source files (`notebook.py` + `pyproject.toml`); `workspace`
 * also captures the rest of the working dir into the notebook's `workspace/` on
 * teardown and restores it on the next session. Throws on any other value.
 */
function parsePersistWorkspace(env: Env): 'source' | 'workspace' {
	const raw = env.MARIMOHUB_PERSIST_WORKSPACE?.trim().toLowerCase();
	if (raw === undefined || raw === '') return 'source';
	if (raw === 'source' || raw === 'workspace') return raw;
	throw new ConfigError(
		`Invalid MARIMOHUB_PERSIST_WORKSPACE: ${env.MARIMOHUB_PERSIST_WORKSPACE} (expected source or workspace)`,
		{ variable: 'MARIMOHUB_PERSIST_WORKSPACE' },
	);
}

/**
 * Reject a sandbox hostname that shares an origin or parent domain with the app.
 * Notebook kernels run untrusted user code; if they are served same-origin (or on
 * the same registrable domain) as the control plane, a malicious notebook can
 * escape the iframe sandbox (`allow-scripts allow-same-origin`) into the app's
 * origin, or set cookies on the shared parent domain. Sandboxes must live on a
 * separate domain (e.g. `sandboxes.example.net`).
 *
 * The app's public host is derived from the OIDC redirect URI when present (the
 * only public-origin signal in env); skipped for other auth backends. The
 * suffix check catches the common same-eTLD+1 cases (app ⊃ sandbox or vice
 * versa) without a public-suffix list — it errs toward rejecting; if it ever
 * blocks a legitimate cross-eTLD setup that merely shares a label suffix, set
 * the hosts so neither is a dotted suffix of the other.
 */
function assertSandboxHostIsolated(env: Env): void {
	const { isolated, sandboxHost, appHost, reason } = checkSandboxHostIsolation(env);
	if (isolated) return;
	const detail =
		reason === 'unverifiable-redirect'
			? `MARIMOHUB_AUTH_OIDC_REDIRECT_URI does not yield a usable app host, so isolation of ` +
				`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (${sandboxHost}) cannot be verified. Set a valid ` +
				`absolute http(s) redirect URI.`
			: `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME (${sandboxHost}) shares an origin/parent domain with the ` +
				`app host (${appHost}).`;
	throw new ConfigError(
		`${detail} Notebook kernels run untrusted code and must be isolated on a separate domain ` +
			`(e.g. sandboxes.example.net) so a malicious notebook cannot escape the iframe sandbox into ` +
			`the control plane or set cookies on the shared domain.`,
		{
			variable: 'MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME',
			remediation: 'Serve kernels from a separate domain (e.g. sandboxes.example.net).',
			docs: 'docs/security.md',
		},
	);
}

/**
 * Select the sandbox-exposure (render) mode — how kernels are surfaced to the
 * browser, independent of the compute backend. `subdomain` (default) is today's
 * direct-to-isolated-domain behavior; `proxy` forwards kernel traffic through the
 * app. Proxy mode fails closed: it requires an explicit acknowledgement that it
 * serves untrusted code same-origin (XSS-capable), and a signing secret for its
 * routing tokens (reused from the session secret).
 */
function parseSandboxExposure(env: Env): SandboxExposure {
	const raw = env.MARIMOHUB_SANDBOX_EXPOSURE?.trim().toLowerCase();
	const mode = raw === undefined || raw === '' ? 'subdomain' : raw;
	if (mode === 'subdomain') {
		return new SubdomainExposure();
	}
	if (mode === 'proxy') {
		if (env.MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED !== 'true') {
			throw new ConfigError(
				'MARIMOHUB_SANDBOX_EXPOSURE=proxy serves untrusted notebook kernels same-origin with the ' +
					'app (a malicious notebook can script the control plane via XSS). Set ' +
					'MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true to acknowledge this and enable proxy mode, ' +
					'or use the default `subdomain` mode (isolated kernel domain).',
				{ variable: 'MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED', docs: 'docs/security.md' },
			);
		}
		const secret = env.MARIMOHUB_AUTH_SESSION_SECRET;
		if (!secret) {
			throw new ConfigError(
				'MARIMOHUB_SANDBOX_EXPOSURE=proxy requires MARIMOHUB_AUTH_SESSION_SECRET to sign its ' +
					'routing tokens (the same secret that signs session cookies).',
				{ variable: 'MARIMOHUB_AUTH_SESSION_SECRET', docs: 'docs/security.md' },
			);
		}
		// The ProxyExposure carries the signing secret; no separate dep is threaded.
		return new ProxyExposure(secret);
	}
	throw new ConfigError(
		`Invalid MARIMOHUB_SANDBOX_EXPOSURE: ${env.MARIMOHUB_SANDBOX_EXPOSURE} (expected subdomain or proxy)`,
		{ variable: 'MARIMOHUB_SANDBOX_EXPOSURE', docs: 'docs/security.md' },
	);
}

export function createFromEnv(env: Env = process.env, metrics?: Metrics): ApiDeps {
	const bucket = makeStorage(env);
	const exposure = parseSandboxExposure(env);
	// The same-origin isolation guard only applies to `subdomain` mode (a separate
	// public kernel domain). `proxy` mode is intentionally same-origin and gated by
	// its own explicit acknowledgement above.
	if (exposure.mode === 'subdomain') assertSandboxHostIsolated(env);
	const { authenticator, authRoutes } = makeAuth(env);
	const sessionLifetime = parseSessionLifetime(env);
	const sandboxImages = resolveSandboxImages(env);
	const services = createServices(bucket, metrics);
	const deps: ApiDeps = {
		services,
		bucket,
		// The provider-side lifetime cap (CoreWeave/E2B) defaults to 2× the session
		// TTL: an orphan backstop only, so the record-driven sweep always gets to
		// save + teardown gracefully before the provider hard-kills.
		compute: makeCompute(env, {
			sessionMaxLifetimeSeconds: Millis.toSeconds(sessionLifetime.maxLifetimeMs),
		}),
		// Personal access tokens ride on every deployment: a `mhub_pat_` bearer
		// resolves through the TokenService, everything else through the SSO adapter.
		authenticator: composeAuthenticators(services.tokens, authenticator),
		authRoutes,
		sandbox: {
			bucket: makeSandboxBucketConfig(env),
			hostname: env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME ?? '',
			workdir: env.MARIMOHUB_COMPUTE_WORKDIR ?? '/workspace',
			assetUrl: env.MARIMOHUB_COMPUTE_ASSET_URL,
			exposure,
			appBaseUrl: env.MARIMOHUB_APP_BASE_URL,
			persistWorkspace: parsePersistWorkspace(env),
			sessionLifetime,
			images: sandboxImages,
		},
		policy: {
			defaultRole: parseDefaultRole(env),
			viewerMode: parseViewerMode(env),
			allowedOrigins: parseList(env.MARIMOHUB_ALLOWED_ORIGINS),
			maxConcurrentSessionsPerUser: parseSessionCap(env),
			maxAppsPerProject: parseAppCap(env),
		},
		// Workload Identity Federation (no-op unless the WIF env vars are configured).
		...makeWif(env),
		// Managed AI proxy (no-op unless MARIMOHUB_AI_BACKEND is configured).
		...makeAi(env),
		// Project secrets (no-op unless MARIMOHUB_SECRETS_BACKEND is configured).
		...makeSecrets(env, bucket),
		// Deployment metadata surfaced read-only via GET /api/v1/version (UI footer).
		// MARIMOHUB_VERSION / MARIMOHUB_IMAGE are baked into the image at build time
		// (Dockerfile ARG → ENV); everything else is inferred from the live config +
		// runtime. HOSTNAME is set to the pod name by Kubernetes.
		version: {
			version: env.MARIMOHUB_VERSION ?? 'dev',
			image: env.MARIMOHUB_IMAGE,
			// The default (first configured) image; the full list is on /capabilities.
			sandboxImage: sandboxImages[0],
			startedAt: PROCESS_STARTED_AT,
			replica: env.HOSTNAME,
			node: process.version,
			backends: {
				storage: env.MARIMOHUB_STORAGE_BACKEND ?? 's3',
				// Always set: makeCompute above threw if it was missing.
				compute: env.MARIMOHUB_COMPUTE_BACKEND ?? 'unset',
				auth: env.MARIMOHUB_AUTH_BACKEND ?? 'unset',
			},
		},
	};
	// Deploy-time diagnostics: probe downstream deps (storage/auth/compute/WIF).
	// Logged once (non-fatal) at boot and served by GET /api/health?deep=true.
	deps.preflight = () => runPreflight(buildPreflightChecks(env, deps));
	return deps;
}
