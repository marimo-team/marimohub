/**
 * marimohub Node entrypoint (Docker / Kubernetes control plane).
 *
 * Composes the provider-agnostic API with adapters selected from MARIMOHUB_*
 * env (S3 storage + Modal compute + app-native OIDC by default), serves the
 * prebuilt SPA, and runs session maintenance. The API tier is stateless — all
 * state lives in object storage + compute — so this scales horizontally.
 */
import { bootstrap } from './bootstrap';
import { logEvent } from './log';

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

// Keep server-owned env reads at the process boundary, where the config registry
// inventories them; adapter env remains opaque to this entrypoint.
await bootstrap({
	...process.env,
	PORT: process.env.PORT,
	MARIMOHUB_STATIC_ROOT: process.env.MARIMOHUB_STATIC_ROOT,
	MARIMOHUB_RUN_MAINTENANCE: process.env.MARIMOHUB_RUN_MAINTENANCE,
});
