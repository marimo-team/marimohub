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
	ASSIGNABLE_ROLES,
	EDITOR_SANDBOX_SHARING_VALUES,
	runPreflight,
	SubdomainExposure,
	VIEWER_MODES,
} from '@marimo-hub/core';
import type {
	EditorSandboxSharing,
	Metrics,
	AssignableRole,
	SandboxExposure,
	ViewerMode,
} from '@marimo-hub/core';
import type { ApiDeps, SessionLifetimeConfig } from '@marimo-hub/api';
import { makeAi } from './ai';
import { makeAuth } from './auth';
import { buildConfigSummary } from './configSummary';
import { makeCompute, resolveSandboxImages } from './compute';
import {
	parseComputeProfileOverride,
	parseComputeProfiles,
	resolveResources,
	supportsComputeProfiles,
	unsupportedBackendNotice,
} from './computeProfiles';
import { makeIntegrations } from './integrations';
import { makeStorage, makeSandboxBucketConfig } from './storage';
import { makeWif } from './wif';
import { makeSandboxUserHome } from './userHome';
import { parseEnum, parseEnumOr, parseIntEnv, parseList } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';
import { checkSandboxHostIsolation } from './hostIsolation';
import { buildPreflightChecks } from './preflightChecks';

export { ConfigError, isConfigError } from './errors';
export type { ConfigErrorOptions } from './errors';
export {
	ComputeProfileConfigError,
	hasConfiguredResources,
	parseComputeProfileOverride,
	parseComputeProfiles,
	resolveResources,
	supportsComputeProfiles,
	unsupportedBackendNotice,
} from './computeProfiles';
export type {
	ComputeProfile,
	ComputeProfileOverride,
	ComputeProfilesConfig,
	ComputeResources,
} from './computeProfiles';

const warnedUnsupportedProfileBackends = new Set<string>();

/**
 * When this process started, captured once at module load. Surfaced by
 * `GET /api/v1/version` so the UI can show when the pod last (re)started — distinct
 * from the image's build time.
 */
const PROCESS_STARTED_AT = new Date().toISOString();

/** Default concurrent-session cap per user when unset (a cost-DoS guard). */
const DEFAULT_MAX_SESSIONS_PER_USER = 10;

/** Default per-project concurrent app (`run`) session cap when unset. */
const DEFAULT_MAX_APPS_PER_PROJECT = 5;

/**
 * Parse a concurrency cap. `0` disables the cap (unlimited); unset falls back to
 * `dflt`. Not `parseIntEnv`: that treats `''` as unset but not `'  '`, and does
 * not reject a negative or fractional cap.
 */
function parseCap(env: Env, key: string, dflt: number): number | undefined {
	const raw = env[key];
	// Empty means unset, NOT `Number('') === 0` (which would silently disable the cap).
	if (raw === undefined || raw.trim() === '') return dflt;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new ConfigError(`Invalid ${key}: ${raw} (expected a non-negative integer)`, {
			variable: key,
			remediation: 'Use 0 (unlimited) or a positive integer.',
		});
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
 * members-only. Project edit/delete always requires `manager`, so even `editor`
 * here cannot reach it.
 */
function parseDefaultRole(env: Env): AssignableRole | undefined {
	// `none` deserializes to undefined (members-only); unset falls back to `editor`.
	return parseEnum(env, 'MARIMOHUB_DEFAULT_ROLE', {
		allowed: ASSIGNABLE_ROLES,
		fallback: 'editor',
		offValues: ['none'],
	});
}

/**
 * What an effective `viewer` gets, each tier a superset of the last. `static`
 * (the default) serves the last captured HTML snapshot — no compute, no code
 * execution; `applications` also admits viewers to the shared notebook app;
 * `ephemeral-sandbox` additionally provisions a real edit kernel whose session
 * is never written back. Throws on any other value.
 */
function parseViewerMode(env: Env): ViewerMode {
	return parseEnumOr(env, 'MARIMOHUB_VIEWER_MODE', VIEWER_MODES, 'static');
}

function parseEditorSandboxSharing(env: Env): EditorSandboxSharing {
	return parseEnumOr(
		env,
		'MARIMOHUB_EDITOR_SANDBOX_SHARING',
		EDITOR_SANDBOX_SHARING_VALUES,
		'shared',
	);
}

/**
 * Which sandbox working-dir files survive a session. `source` (the default)
 * persists only the source files (`notebook.py` + `pyproject.toml`); `workspace`
 * also captures the rest of the working dir into the notebook's `workspace/` on
 * teardown and restores it on the next session. Throws on any other value.
 */
function parsePersistWorkspace(env: Env): 'source' | 'workspace' {
	return parseEnumOr(
		env,
		'MARIMOHUB_PERSIST_WORKSPACE',
		['source', 'workspace'] as const,
		'source',
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

export interface CreateFromEnvOptions {
	/** Wrap the bucket and services in OTEL spans (see `createServices`). */
	tracing?: boolean;
}

export function createFromEnv(
	env: Env = process.env,
	metrics?: Metrics,
	options?: CreateFromEnvOptions,
): ApiDeps {
	const bucket = makeStorage(env);
	const exposure = parseSandboxExposure(env);
	// The same-origin isolation guard only applies to `subdomain` mode (a separate
	// public kernel domain). `proxy` mode is intentionally same-origin and gated by
	// its own explicit acknowledgement above.
	if (exposure.mode === 'subdomain') assertSandboxHostIsolated(env);
	const { authenticator, authRoutes } = makeAuth(env);
	const sessionLifetime = parseSessionLifetime(env);
	const sandboxImages = resolveSandboxImages(env);
	const computeProfiles = parseComputeProfiles(env.MARIMOHUB_COMPUTE_PROFILES);
	const computeBackend = env.MARIMOHUB_COMPUTE_BACKEND ?? 'unset';
	const profilesSupported = supportsComputeProfiles(computeBackend);
	const computeResources = profilesSupported ? resolveResources(computeProfiles) : {};
	const computeProfileOverride = parseComputeProfileOverride(
		env.MARIMOHUB_COMPUTE_PROFILE_OVERRIDE,
	);
	const editorSandboxSharing = parseEditorSandboxSharing(env);
	const userHome = makeSandboxUserHome(env, editorSandboxSharing);
	const profileNotice = unsupportedBackendNotice(
		computeBackend,
		computeProfiles,
		computeProfileOverride,
	);
	if (profileNotice && !warnedUnsupportedProfileBackends.has(computeBackend)) {
		console.warn(profileNotice);
		warnedUnsupportedProfileBackends.add(computeBackend);
	}
	const services = createServices(bucket, metrics, { tracing: options?.tracing });
	const deps: ApiDeps = {
		services,
		bucket,
		// Provider-side limits trail the graceful lifecycle deadlines: Modal idle by
		// 1.5× and CoreWeave/E2B lifetime by 2×.
		compute: makeCompute(env, {
			sessionMaxLifetimeSeconds: Millis.toSeconds(sessionLifetime.maxLifetimeMs),
			sessionIdleTimeoutMs: sessionLifetime.idleTimeoutMs,
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
			resources: computeResources,
			computeProfile: profilesSupported ? computeProfiles.defaultProfile?.name : undefined,
			computeProfiles: profilesSupported ? [...computeProfiles.profiles] : [],
			computeProfileOverride: profilesSupported ? computeProfileOverride : 'none',
			userHome,
		},
		policy: {
			defaultRole: parseDefaultRole(env),
			viewerMode: parseViewerMode(env),
			editorSandboxSharing,
			allowedOrigins: parseList(env.MARIMOHUB_ALLOWED_ORIGINS),
			superAdmins: parseList(env.MARIMOHUB_SUPER_ADMINS),
			maxConcurrentSessionsPerUser: parseCap(
				env,
				'MARIMOHUB_MAX_SESSIONS_PER_USER',
				DEFAULT_MAX_SESSIONS_PER_USER,
			),
			maxAppsPerProject: parseCap(
				env,
				'MARIMOHUB_MAX_APPS_PER_PROJECT',
				DEFAULT_MAX_APPS_PER_PROJECT,
			),
		},
		// Read-only configuration for the super-admin settings page (secrets
		// redacted at assembly).
		configSummary: buildConfigSummary(env),
		// Workload Identity Federation (no-op unless the WIF env vars are configured).
		...makeWif(env),
		// Managed AI proxy (no-op unless MARIMOHUB_AI_BACKEND is configured).
		...makeAi(env),
		// Project integrations (no-op unless MARIMOHUB_INTEGRATIONS=on — opt-in per the
		// two-phase rollout note on makeIntegrations).
		...makeIntegrations(env, bucket, metrics),
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
