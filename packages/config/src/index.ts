/**
 * Configuration composition root.
 *
 * `createFromEnv()` reads the `MARIMOHUB_*` environment, selects an adapter per
 * `*_BACKEND` selector, and returns the wired `ApiDeps` that `createApi` consumes.
 * This is the ONLY package that imports concrete adapters, so the dependency
 * graph still points inward (core/api never import it).
 *
 * The `r2` / `cloudflare` / `cloudflare-access` selectors are Workers-only (they
 * need platform bindings, not env credentials) and are wired by hand in
 * examples/cloudflare-worker rather than here.
 */
import {
	createServices,
	type BucketConfig,
	type Bucket,
	type Metrics,
	type SandboxProvider,
	type Authenticator,
} from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from '@marimo-hub/api';
import { S3Storage } from '@marimo-hub/storage-s3';
import { LocalCompute } from '@marimo-hub/compute-local';
import { ModalCompute } from '@marimo-hub/compute-modal';
import { createOidcAuth } from '@marimo-hub/auth-oidc';
import { DevAuthenticator } from '@marimo-hub/auth-dev';
import type { Hono } from 'hono';

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
	const value = env[key];
	if (!value) throw new Error(`Missing required env var: ${key}`);
	return value;
}

function s3Credentials(env: Env) {
	return env.MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID && env.MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY
		? {
			accessKeyId: env.MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID,
			secretAccessKey: env.MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY,
		}
		: undefined;
}

function makeStorage(env: Env): Bucket {
	const backend = env.MARIMOHUB_STORAGE_BACKEND ?? 's3';
	switch (backend) {
		case 's3':
			return new S3Storage({
				bucket: required(env, 'MARIMOHUB_STORAGE_S3_BUCKET'),
				endpoint: env.MARIMOHUB_STORAGE_S3_ENDPOINT,
				region: env.MARIMOHUB_STORAGE_S3_REGION,
				credentials: s3Credentials(env),
				forcePathStyle: env.MARIMOHUB_STORAGE_S3_FORCE_PATH_STYLE === 'true',
			});
		case 'memory':
			// The in-memory bucket is NON-DURABLE — all state is lost on restart. It
			// exists for local dev and tests only. Refuse it unless the operator
			// explicitly opts in, so it can never back a real deployment by accident
			// (the supported durable backends are `s3` and, in Workers, `r2`).
			if (env.MARIMOHUB_ALLOW_EPHEMERAL_STORAGE !== 'true') {
				throw new Error(
					'MARIMOHUB_STORAGE_BACKEND=memory is non-durable (all state is lost on restart) and is for ' +
					'local dev/tests only. Set MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true to use it, or choose a ' +
					'durable backend (s3).',
				);
			}
			return new MemoryBucket();
		case 'r2':
			throw new Error(
				'MARIMOHUB_STORAGE_BACKEND=r2 requires a Cloudflare R2 binding; wire it in examples/cloudflare-worker.',
			);
		default:
			throw new Error(`Unknown MARIMOHUB_STORAGE_BACKEND: ${backend}`);
	}
}

/** Parse a `"start-end"` port range (e.g. `2718-2723`); undefined if unset. */
function parsePortRange(value: string | undefined): { start: number; end: number } | undefined {
	if (!value) return undefined;
	const m = value.match(/^(\d+)-(\d+)$/);
	if (!m) throw new Error(`Invalid MARIMOHUB_COMPUTE_LOCAL_PORTS: ${value} (expected "start-end")`);
	return { start: Number(m[1]), end: Number(m[2]) };
}

function makeCompute(env: Env): SandboxProvider {
	const backend = env.MARIMOHUB_COMPUTE_BACKEND ?? 'modal';
	switch (backend) {
		case 'modal':
			return new ModalCompute({
				tokenId: required(env, 'MARIMOHUB_COMPUTE_MODAL_TOKEN_ID'),
				tokenSecret: required(env, 'MARIMOHUB_COMPUTE_MODAL_TOKEN_SECRET'),
				image: required(env, 'MARIMOHUB_COMPUTE_IMAGE'),
				// App name scopes reconciler enumeration (listActive) to sandboxes this
				// deployment owns, so it never reaps co-tenant sandboxes in the workspace.
				appName: env.MARIMOHUB_COMPUTE_MODAL_APP_NAME,
				idleTimeout: env.MARIMOHUB_COMPUTE_IDLE_TIMEOUT,
			});
		case 'local':
			// Dev backend: spawns `uv run marimo edit` as a host subprocess and
			// serves the kernel at http://<host>:<port> for the browser to iframe.
			// Requires `uv` + Python on the host; not for shared/production use.
			// In Docker, set BIND_HOST=0.0.0.0 + PORTS to a published range.
			return new LocalCompute({
				host: env.MARIMOHUB_COMPUTE_LOCAL_HOST,
				bindHost: env.MARIMOHUB_COMPUTE_LOCAL_BIND_HOST,
				ports: parsePortRange(env.MARIMOHUB_COMPUTE_LOCAL_PORTS),
			});
		case 'cloudflare':
			throw new Error(
				'MARIMOHUB_COMPUTE_BACKEND=cloudflare requires a Workers Durable Object binding; wire it in examples/cloudflare-worker.',
			);
		case 'none':
		case 'noop':
			// No compute: storage/auth/API work and notebooks are browsable, but
			// provisioning a kernel session fails. Useful for local dev without Modal.
			return {
				create() {
					throw new Error(
						'No compute backend configured (MARIMOHUB_COMPUTE_BACKEND=none). Set it to "modal" to run kernels.',
					);
				},
				async proxy() {
					return null;
				},
			};
		default:
			throw new Error(`Unknown MARIMOHUB_COMPUTE_BACKEND: ${backend}`);
	}
}

function makeAuth(env: Env): { authenticator: Authenticator; authRoutes?: Hono } {
	const backend = env.MARIMOHUB_AUTH_BACKEND;
	if (!backend) {
		throw new Error(
			'MARIMOHUB_AUTH_BACKEND must be set explicitly (oidc | cloudflare-access | dev). ' +
			'Refusing to start: an unset auth backend previously defaulted to the insecure dev bypass.',
		);
	}
	switch (backend) {
		case 'oidc': {
			const { authenticator, routes } = createOidcAuth({
				issuer: required(env, 'MARIMOHUB_AUTH_OIDC_ISSUER'),
				clientId: required(env, 'MARIMOHUB_AUTH_OIDC_CLIENT_ID'),
				clientSecret: required(env, 'MARIMOHUB_AUTH_OIDC_CLIENT_SECRET'),
				redirectUri: required(env, 'MARIMOHUB_AUTH_OIDC_REDIRECT_URI'),
				audience: env.MARIMOHUB_AUTH_OIDC_AUDIENCE,
				sessionSecret: required(env, 'MARIMOHUB_AUTH_SESSION_SECRET'),
			});
			return { authenticator, authRoutes: routes };
		}
		case 'dev':
			return {
				authenticator: new DevAuthenticator({
					userId: env.MARIMOHUB_AUTH_DEV_USER_ID,
					email: env.MARIMOHUB_AUTH_DEV_EMAIL,
				}),
			};
		case 'cloudflare-access':
			throw new Error(
				'MARIMOHUB_AUTH_BACKEND=cloudflare-access is wired in examples/cloudflare-worker.',
			);
		default:
			throw new Error(`Unknown MARIMOHUB_AUTH_BACKEND: ${backend}`);
	}
}

/** The S3 connection info a sandbox uses to read/write notebook files. */
function makeSandboxBucketConfig(env: Env): BucketConfig {
	return {
		name: env.MARIMOHUB_STORAGE_S3_BUCKET ?? '',
		endpoint: env.MARIMOHUB_STORAGE_S3_ENDPOINT ?? '',
		credentials: s3Credentials(env),
	};
}

/** Default concurrent-session cap per user when unset (a cost-DoS guard). */
const DEFAULT_MAX_SESSIONS_PER_USER = 10;

/** Parse the per-user concurrent-session cap. `0` disables the cap (unlimited). */
function parseSessionCap(env: Env): number | undefined {
	const raw = env.MARIMOHUB_MAX_SESSIONS_PER_USER;
	if (raw === undefined) return DEFAULT_MAX_SESSIONS_PER_USER;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(
			`Invalid MARIMOHUB_MAX_SESSIONS_PER_USER: ${raw} (expected a non-negative integer)`,
		);
	}
	return n === 0 ? undefined : n;
}

/** Comma-separated extra Origins allowed for state-changing requests (CSRF). */
function parseAllowedOrigins(env: Env): string[] | undefined {
	const raw = env.MARIMOHUB_ALLOWED_ORIGINS;
	if (!raw) return undefined;
	const origins = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return origins.length > 0 ? origins : undefined;
}

export function createFromEnv(env: Env = process.env, metrics?: Metrics): ApiDeps {
	const bucket = makeStorage(env);
	const { authenticator, authRoutes } = makeAuth(env);
	return {
		services: createServices(bucket, metrics),
		bucket,
		compute: makeCompute(env),
		authenticator,
		authRoutes,
		sandboxBucket: makeSandboxBucketConfig(env),
		sandboxHostname: env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME ?? '',
		maxConcurrentSessionsPerUser: parseSessionCap(env),
		allowedOrigins: parseAllowedOrigins(env),
	};
}
