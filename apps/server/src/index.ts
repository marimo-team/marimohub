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
import { secureHeaders } from 'hono/secure-headers';
import type { ApiDeps } from '@marimo-hub/api';
import { createApi } from '@marimo-hub/api';
import { createFromEnv, isConfigError } from '@marimo-hub/config';
import { startMaintenance, startSessionLifecycle } from './cron';
import { logEvent } from './log';
import { WideEventMetrics } from './metrics';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

// Process-level safety net. A rejected promise with no catch handler — e.g. a
// transient CoreWeave sandbox gRPC stream reset (ECONNRESET) that surfaces after
// the awaited call already returned — must not take down a request-serving
// replica. Log it as a structured event and keep serving; the readiness probe
// and the other replicas absorb anything genuinely fatal.
process.on('unhandledRejection', (reason) => {
	logEvent({
		level: 'error',
		event: 'unhandled_rejection',
		error: reason instanceof Error ? reason.message : String(reason),
		name: reason instanceof Error ? reason.name : undefined,
		stack: reason instanceof Error ? reason.stack : undefined,
	});
});

// An uncaught *synchronous* exception leaves process state undefined, so log and
// exit — Kubernetes restarts the pod cleanly rather than letting it limp on.
process.on('uncaughtException', (err) => {
	logEvent({
		level: 'error',
		event: 'uncaught_exception',
		error: err.message,
		name: err.name,
		stack: err.stack,
	});
	process.exit(1);
});

// Telemetry sink: services emit CAS/reaper/snapshot signals here; the maintenance
// loop flushes them as one wide event per cycle (and request-path CAS contention
// surfaces at the next flush).
const metrics = new WideEventMetrics();

// Config errors are deterministic — a restart can't fix them — so print a readable
// remediation block to stderr and exit. (Transient backend problems go through the
// non-fatal preflight below instead, so they never crashloop a replica.)
let deps: ApiDeps;
try {
	deps = createFromEnv(process.env, metrics);
} catch (err) {
	if (isConfigError(err)) {
		console.error(`\n${err.format()}\n`);
		process.exit(1);
	}
	throw err;
}
const app = createApi(deps);

// Boot preflight: probe downstream deps (storage conditional-writes, OIDC
// discovery, WIF key, compute). Log each non-ok check, but DO NOT exit on a
// connectivity failure — a transient blip must not crashloop the pod. Exit only on
// a `fatal` result: a deterministic, unsafe-to-run misconfiguration (e.g. a store
// that ignores conditional writes, which would corrupt the catalog).
const report = await deps.preflight?.();
if (report) {
	for (const check of report.checks) {
		if (check.status === 'ok' || check.status === 'skipped') continue;
		logEvent({
			level: check.status === 'fail' ? 'error' : 'warn',
			event: 'preflight_check',
			check: check.name,
			status: check.status,
			message: check.message,
			remediation: check.remediation,
			fatal: check.fatal ?? false,
			latencyMs: check.latencyMs,
		});
	}
	logEvent({ level: 'info', event: 'preflight_complete', ok: report.ok, fatal: report.fatal });
	if (report.fatal) {
		logEvent({ level: 'error', event: 'boot_failed', reason: 'preflight_fatal' });
		process.exit(1);
	}
}

// Security headers for the SPA/static responses: anti-clickjacking
// (X-Frame-Options: SAMEORIGIN), MIME-sniffing (nosniff), HSTS, Referrer-Policy,
// and cross-origin isolation defaults. Registered after createApi, so it wraps the
// fall-through static/HTML responses (the framing/XSS-delivery surface); the
// terminal /api/* JSON routes inside createApi are unaffected. No CSP is set here —
// a tuned CSP (allowing the font CDN + the sandbox iframe origin) is a follow-up.
app.use('*', secureHeaders());

// Serve the prebuilt SPA. API routes (registered inside createApi) are terminal,
// so they take precedence; everything else falls through to static assets, with
// a single-page-app fallback to index.html.
const staticRoot = process.env.MARIMOHUB_STATIC_ROOT ?? './public';
app.use('/*', serveStatic({ root: staticRoot }));
app.get('*', serveStatic({ path: `${staticRoot}/index.html` }));

// Maintenance + session-lifecycle loops — run on a single replica (the
// marimohub-maintenance Deployment). The bucket-CAS leases inside are
// defense-in-depth guards.
if (process.env.MARIMOHUB_RUN_MAINTENANCE === 'true') {
	startMaintenance(deps, metrics);
	startSessionLifecycle(deps);
}

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[marimohub] server listening on :${info.port}`);
});

// In `proxy` exposure mode, forward `…/proxy/<token>/` WebSocket upgrades to the
// kernel (the HTTP side is handled inside `app.fetch`). A no-op otherwise.
attachSandboxProxyUpgrade(server, deps);
