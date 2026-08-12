import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiDeps } from '@marimo-hub/api';
import { createApi } from '@marimo-hub/api';
import { createFromEnv, isConfigError } from '@marimo-hub/config';
import { startMaintenance, startSessionLifecycle } from './cron';
import { validateServerEnv } from './env';
import { logEvent } from './log';
import { fanoutMetrics, OtelMetrics, WideEventMetrics } from './metrics';
import { startOtel } from './otel';
import { settleAllWithin } from './promise';
import { serveSpaFallback, serveStaticWithCache } from './staticCache';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

const DRAIN_TIMEOUT_MS = 10_000;

type Signal = 'SIGTERM' | 'SIGINT';

export interface BootstrapOverrides {
	createDeps?: typeof createFromEnv;
	prepareDeps?: (deps: ApiDeps) => Promise<void>;
	serveFn?: typeof serve;
	startOtelFn?: typeof startOtel;
	exit?: (code: number) => void;
	registerSignal?: (signal: Signal, handler: () => void) => void | (() => void);
}

export interface BootstrapHandle extends AsyncDisposable {
	server: ServerType;
	drain(): Promise<void>;
}

export async function bootstrap(
	env: Record<string, string | undefined>,
	overrides: BootstrapOverrides = {},
): Promise<BootstrapHandle | undefined> {
	const createDeps = overrides.createDeps ?? createFromEnv;
	const prepareDeps = overrides.prepareDeps;
	const serveFn = overrides.serveFn ?? serve;
	const startOtelFn = overrides.startOtelFn ?? startOtel;
	const exit = overrides.exit ?? ((code) => process.exit(code));
	const registerSignal =
		overrides.registerSignal ??
		((signal: Signal, handler: () => void) => {
			process.once(signal, handler);
			return () => process.off(signal, handler);
		});

	// Telemetry sink: services emit CAS/reaper/snapshot signals here; the maintenance
	// loop flushes them as one wide event per cycle (and request-path CAS contention
	// surfaces at the next flush).
	const wideEvents = new WideEventMetrics();

	// Tracing + metrics (standard OTEL_* env vars); the global providers must
	// register before requests are served.
	const otel = startOtelFn();

	// Fan domain metrics out to OTEL when its metrics pillar is on; the maintenance
	// loop below still flushes `wideEvents` directly.
	const metrics = otel?.metrics ? fanoutMetrics(wideEvents, new OtelMetrics()) : wideEvents;

	// Config errors are deterministic — a restart can't fix them — so print a readable
	// remediation block to stderr and exit. (Transient backend problems go through the
	// non-fatal preflight below instead, so they never crashloop a replica.)
	let validatedEnv: Record<string, string | undefined>;
	let deps: ApiDeps;
	try {
		validatedEnv = validateServerEnv(env);
		deps = createDeps(validatedEnv, metrics, { tracing: otel?.tracing ?? false });
		await prepareDeps?.(deps);
	} catch (err) {
		if (isConfigError(err)) {
			console.error(`\n${err.format()}\n`);
			exit(1);
			return undefined;
		}
		throw err;
	}
	// Installed for metrics-only mode too: RED metrics still record, spans don't.
	if (otel)
		deps.tracingMiddleware = httpInstrumentationMiddleware({ disableTracing: !otel.tracing });
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
			exit(1);
			return undefined;
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
	const staticRoot = validatedEnv.MARIMOHUB_STATIC_ROOT ?? './public';
	app.use('/*', serveStaticWithCache({ root: staticRoot }));
	app.get('*', serveSpaFallback(staticRoot));

	// Maintenance + session-lifecycle loops — run on a single replica (the
	// marimohub-maintenance Deployment). The bucket-CAS leases inside are
	// defense-in-depth guards.
	const stops: (() => void)[] = [];
	if (validatedEnv.MARIMOHUB_RUN_MAINTENANCE === 'true') {
		stops.push(startMaintenance(deps, wideEvents));
		const stopLifecycle = startSessionLifecycle(deps);
		if (stopLifecycle) stops.push(stopLifecycle);
	}

	const port = Number(validatedEnv.PORT ?? 3000);
	const server = serveFn({ fetch: app.fetch, port }, (info) => {
		console.log(`[marimohub] server listening on :${info.port}`);
	});

	// In `proxy` exposure mode, forward `…/proxy/<token>/` WebSocket upgrades to the
	// kernel (the HTTP side is handled inside `app.fetch`). A no-op otherwise.
	attachSandboxProxyUpgrade(server, deps);

	const unregisterSignals: (() => void)[] = [];
	let drainPromise: Promise<void> | undefined;
	const drain = (): Promise<void> => {
		drainPromise ??= (async () => {
			for (const unregisterSignal of unregisterSignals.splice(0)) unregisterSignal();
			// Cancel future ticks first. An in-flight sweep still has the remaining drain
			// window to release its lease; the lease TTL is the fallback if it outlives it.
			for (const stopLoop of stops) stopLoop();

			const closed = new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			if ('closeIdleConnections' in server) server.closeIdleConnections();

			// Long-lived WebSockets can keep close pending indefinitely. Ten seconds stays
			// below Kubernetes' default 30-second termination grace period.
			const result = await settleAllWithin(
				[
					closed,
					...(deps.dataBrowser?.close ? [closed.then(() => deps.dataBrowser?.close?.())] : []),
					...(otel ? [Promise.resolve().then(() => otel.shutdown())] : []),
				],
				DRAIN_TIMEOUT_MS,
			);
			// A timed-out drain still resolves (settleAllWithin never rejects), so surface it
			// here or the forced termination looks like a clean shutdown.
			if (result === 'timed-out')
				logEvent({ level: 'warn', event: 'drain_timeout', timeoutMs: DRAIN_TIMEOUT_MS });
		})();
		return drainPromise;
	};

	const handle: BootstrapHandle = {
		server,
		drain,
		[Symbol.asyncDispose]: drain,
	};
	const drainAndExit = () => {
		void drain().then(
			() => exit(0),
			(err: unknown) => {
				logEvent({
					level: 'error',
					event: 'drain_failed',
					message: err instanceof Error ? err.message : String(err),
				});
				exit(1);
			},
		);
	};
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		const unregisterSignal = registerSignal(signal, drainAndExit);
		if (unregisterSignal) unregisterSignals.push(unregisterSignal);
	}
	return handle;
}
