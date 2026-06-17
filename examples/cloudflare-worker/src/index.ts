/**
 * Cloudflare Workers reference deployment (not an actively-built app — a
 * copy-pasteable example). It composes the SAME provider-agnostic `createApi`
 * with the Cloudflare adapters: R2 storage, Containers compute (Durable Object),
 * and Access auth. This is also the one context where the Cloudflare compute
 * adapter works, since it needs the Workers runtime + DO binding.
 */
import { createApi, type ApiDeps } from '@marimo-hub/api';
import { createServices, MaintenanceLock, ReconciliationService } from '@marimo-hub/core';
import { CloudflareAccessAuthenticator } from '@marimo-hub/auth-cloudflare-access';
import { DevAuthenticator } from '@marimo-hub/auth-dev';
import { CloudflareSandboxProvider, Sandbox } from '@marimo-hub/compute-cloudflare';
import { R2BucketAdapter } from '@marimo-hub/storage-r2';

// Re-export the Sandbox Durable Object class so wrangler can discover it.
export { Sandbox };

function buildDeps(request: Request, env: Env): ApiDeps {
	const bucket = new R2BucketAdapter(env.NOTEBOOKS_BUCKET);
	const authenticator =
		env.AUTH_MODE === 'access'
			? new CloudflareAccessAuthenticator({
				team: env.ACCESS_TEAM ?? '',
				aud: env.ACCESS_AUD ?? '',
			})
			: new DevAuthenticator({ userId: env.USER_ID, email: env.USER_EMAIL });

	return {
		services: createServices(bucket),
		bucket,
		compute: new CloudflareSandboxProvider(env.SANDBOX),
		authenticator,
		sandboxBucket: {
			name: env.R2_BUCKET_NAME ?? '',
			endpoint: env.R2_S3_ENDPOINT ?? '',
			credentials:
				env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
					? { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
					: undefined,
		},
		sandboxHostname: env.SANDBOX_HOSTNAME || new URL(request.url).hostname,
	};
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		return createApi(buildDeps(request, env)).fetch(request, env, ctx);
	},
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		const bucket = new R2BucketAdapter(env.NOTEBOOKS_BUCKET);
		const { sessions, maintenance } = createServices(bucket);
		const compute = new CloudflareSandboxProvider(env.SANDBOX);

		// The Workers scheduled trigger is already a platform singleton; the lease
		// is belt-and-suspenders, matching the Node deployment's contract.
		const lock = new MaintenanceLock(bucket);
		if (!(await lock.acquire('cloudflare-scheduled'))) return;
		try {
			await sessions.expireStale();
			// Reconcile records against the provider. The Cloudflare adapter omits
			// listActive(), so this cleanly no-ops until that backend can enumerate.
			await new ReconciliationService(sessions, compute, bucket).reconcile();
			await sessions.reapTerminated();
			await maintenance.expireSnapshots();
			await maintenance.pruneEvents();
		} finally {
			await lock.release('cloudflare-scheduled');
		}
	},
};
