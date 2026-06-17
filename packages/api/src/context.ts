import type { Hono } from 'hono';
import type {
	Authenticator,
	AuthUser,
	Bucket,
	BucketConfig,
	createServices,
	SandboxProvider,
} from '@marimo-hub/core';

/** The service bundle produced by `createServices(bucket)` in @marimo-hub/core. */
export type Services = ReturnType<typeof createServices>;

/**
 * Everything the API needs, injected at composition time. This replaces the
 * Cloudflare-specific `Bindings: Env` coupling — routes read it from the Hono
 * context (`c.get('deps')`) instead of instantiating adapters from `c.env`.
 */
export interface ApiDeps {
	services: Services;
	/** Raw bucket handle (used by ensureInitialized + the sandbox copy fallback). */
	bucket: Bucket;
	compute: SandboxProvider;
	authenticator: Authenticator;
	/**
	 * Optional sub-app contributing provider-specific auth routes — e.g. the
	 * app-native OIDC login/callback/logout flow. Mounted before the authN guard
	 * so those routes stay public.
	 */
	authRoutes?: Hono;
	/** Bucket connection info the sandbox mounts (was `c.env.R2_*`). */
	sandboxBucket: BucketConfig;
	/** Public hostname used when exposing kernel ports (was `c.env.SANDBOX_HOSTNAME`). */
	sandboxHostname: string;
	/**
	 * Max concurrent non-terminal sessions a single user may hold. A cost-DoS
	 * guard (each session is billable compute); the create-session route rejects
	 * with 429 past the cap. Unset/undefined = unlimited.
	 */
	maxConcurrentSessionsPerUser?: number;
	/**
	 * Extra Origins allowed for state-changing requests, beyond the deployment's
	 * own (same-origin is always allowed; requests with no Origin — non-browser
	 * clients — are not blocked). CSRF defense-in-depth for the cookie session.
	 */
	allowedOrigins?: string[];
}

export type HonoEnv = {
	Variables: {
		deps: ApiDeps;
		user: AuthUser;
	};
};
