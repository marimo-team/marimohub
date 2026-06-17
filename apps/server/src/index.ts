/**
 * MarimoHub Node entrypoint (Docker / Kubernetes control plane).
 *
 * Composes the provider-agnostic API with adapters selected from MARIMOHUB_*
 * env (S3 storage + Modal compute + app-native OIDC by default), serves the
 * prebuilt SPA, and runs session maintenance. The API tier is stateless — all
 * state lives in object storage + compute — so this scales horizontally.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from '@marimo-hub/api';
import { createFromEnv } from '@marimo-hub/config';
import { startMaintenance } from './cron';
import { logEvent } from './log';
import { WideEventMetrics } from './metrics';

// Telemetry sink: services emit CAS/reaper/snapshot signals here; the maintenance
// loop flushes them as one wide event per cycle (and request-path CAS contention
// surfaces at the next flush).
const metrics = new WideEventMetrics();
const deps = createFromEnv(process.env, metrics);
const app = createApi(deps);

// Boot self-check: refuse to start on an S3 store that doesn't honor conditional
// writes (the catalog compare-and-swap would be unsafe). Best-effort for non-S3.
const bucket = deps.bucket as { verifyConditionalWrites?: () => Promise<void> };
if (typeof bucket.verifyConditionalWrites === 'function') {
	try {
		await bucket.verifyConditionalWrites();
	} catch (err) {
		logEvent({
			level: 'error',
			event: 'boot_failed',
			reason: 'storage_conditional_write_check_failed',
			error: err instanceof Error ? err.message : String(err),
			name: err instanceof Error ? err.name : undefined,
		});
		process.exit(1);
	}
}

// Serve the prebuilt SPA. API routes (registered inside createApi) are terminal,
// so they take precedence; everything else falls through to static assets, with
// a single-page-app fallback to index.html.
const staticRoot = process.env.MARIMOHUB_STATIC_ROOT ?? './public';
app.use('/*', serveStatic({ root: staticRoot }));
app.get('*', serveStatic({ path: `${staticRoot}/index.html` }));

// Maintenance loop — run on a single replica (the marimohub-maintenance
// Deployment). The bucket-CAS lease inside is a defense-in-depth guard.
if (process.env.MARIMOHUB_RUN_MAINTENANCE === 'true') {
	startMaintenance(deps, metrics);
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[marimohub] server listening on :${info.port}`);
});
