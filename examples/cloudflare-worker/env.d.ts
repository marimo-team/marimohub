import type { Sandbox } from '@cloudflare/sandbox';

declare global {
	interface Env {
		NOTEBOOKS_BUCKET: R2Bucket;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		SANDBOX: DurableObjectNamespace<Sandbox<any>>;
		AUTH_MODE?: 'none' | 'access';
		ACCESS_AUD?: string;
		ACCESS_TEAM?: string;
		USER_ID?: string;
		USER_EMAIL?: string;
		R2_BUCKET_NAME?: string;
		R2_S3_ENDPOINT?: string;
		R2_ACCESS_KEY_ID?: string;
		R2_SECRET_ACCESS_KEY?: string;
		SANDBOX_HOSTNAME?: string;
	}
}

export {};
