import type { Sandbox } from '@cloudflare/sandbox';

declare global {
	interface Env {
		NOTEBOOKS_BUCKET: R2Bucket;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		SANDBOX: DurableObjectNamespace<Sandbox<any>>;
		AUTH_MODE?: 'access' | 'dev';
		ACCESS_AUD?: string;
		ACCESS_TEAM?: string;
		USER_ID?: string;
		USER_EMAIL?: string;
		R2_BUCKET_NAME?: string;
		R2_S3_ENDPOINT?: string;
		R2_ACCESS_KEY_ID?: string;
		R2_SECRET_ACCESS_KEY?: string;
		SANDBOX_HOSTNAME?: string;
		SANDBOX_WORKDIR?: string;
		MARIMOHUB_COMPUTE_PROFILES?: string;
		// Opt-in E2B compute (see src/e2b.ts). E2B_API_KEY is a wrangler secret.
		E2B_API_KEY?: string;
		E2B_TEMPLATE?: string;
		DEFAULT_ROLE?: 'viewer' | 'editor' | 'admin' | 'none';
		PERSIST_WORKSPACE?: 'source' | 'workspace';
		AI_UPSTREAM_BASE_URL?: string;
		AI_UPSTREAM_API_KEY?: string;
		AI_MODEL?: string;
		AI_SESSION_SECRET?: string;
		AI_UPSTREAM_PROJECT?: string;
	}
}

export {};
