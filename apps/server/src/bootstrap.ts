import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { secureHeaders } from 'hono/secure-headers';
import { Hono } from 'hono';
import { compress, COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';
import type { ApiDeps } from '@marimo-hub/api';
import { createApi, SANDBOX_PROXY_PREFIXES } from '@marimo-hub/api';
import { createFromEnvAsync, isConfigError } from '@marimo-hub/config';
import { disposeNotifier, InFlightWork } from '@marimo-hub/core';
import {
	startPreviewPreparation,
	startJobScheduler,
	startMaintenance,
	startSessionLifecycle,
	startWarmPools,
} from './cron';
import { validateServerEnv } from './env';
import { BackgroundLoops } from './backgroundLoops';
import { logEvent } from './log';
import { fanoutMetrics, OtelMetrics, WideEventMetrics } from './metrics';
import { buildVersion, startOtel } from './otel';
import { onceAsync, settleAllWithin } from './promise';
import { serveSpaFallback, serveStaticWithCache } from './staticCache';
import { attachSandboxProxyUpgrade } from './sandboxProxyWs';

const CLEANUP_TIMEOUT_MS = 10_000;

type Signal = 'SIGTERM' | 'SIGINT';

export interface BootstrapOverrides {
	createDeps?: (...args: Parameters<typeof createFromEnvAsync>) => ApiDeps | Promise<ApiDeps>;
	prepareDeps?: (deps: ApiDeps) => Promise<void>;
	hostname?: string;
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
	const createDeps = overrides.createDeps ?? createFromEnvAsync;
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

	let thumbnailDeadline: number | undefined;
	// Telemetry sink: services emit CAS/reaper/snapshot signals here; the maintenance
	// loop flushes them as one wide event per cycle (and request-path CAS contention
	// surfaces at the next flush).
	const wideEvents = new WideEventMetrics();

	// Tracing + metrics (standard OTEL_* env vars); the global providers must
	// register before requests are served.
	const otel = startOtelFn(buildVersion(env));

	// Fan domain metrics out to OTEL when its metrics pillar is on; the maintenance
	// loop below still flushes `wideEvents` directly.
	const otelMetrics = otel?.metrics ? new OtelMetrics() : undefined;
	const metrics = otelMetrics ? fanoutMetrics(wideEvents, otelMetrics) : wideEvents;

	// Config errors are deterministic — a restart can't fix them — so print a readable
	// remediation block to stderr and exit. (Transient backend problems go through the
	// non-fatal preflight below instead, so they never crashloop a replica.)
	let validatedEnv: Record<string, string | undefined>;
	let deps: ApiDeps;
	try {
		validatedEnv = validateServerEnv(env);
		deps = await createDeps(validatedEnv, metrics, { tracing: otel?.tracing ?? false });
		await prepareDeps?.(deps);
	} catch (err) {
		if (isConfigError(err)) {
			console.error(`\n${err.format()}\n`);
			exit(1);
			return undefined;
		}
		throw err;
	}
	const drainTimeoutMs =
		Number(
			validatedEnv.MARIMOHUB_SHUTDOWN_TIMEOUT_SECONDS ??
				(validatedEnv.MARIMOHUB_RUN_MAINTENANCE === 'true' ? 120 : 10),
		) * 1000;
	deps.sandbox.thumbnailDeadline = () => thumbnailDeadline;
	const backgroundTasks = new InFlightWork();
	deps.backgroundTasks = {
		defer(task) {
			void backgroundTasks.track(task).catch(() => {});
		},
	};
	// Installed for metrics-only mode too: RED metrics still record, spans don't.
	if (otel)
		deps.tracingMiddleware = httpInstrumentationMiddleware({ disableTracing: !otel.tracing });
	// OTel only: the wide-event sink drops tags, and `loops.collect()` already puts
	// per-loop fields on the maintenance event.
	const loops = new BackgroundLoops(otelMetrics);
	if (validatedEnv.MARIMOHUB_RUN_MAINTENANCE === 'true') deps.loopHealth = () => loops.health();
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

	// Keep SPA policy separate from terminal API, kernel-proxy, and snapshot responses.
	app.use(
		'*',
		secureHeaders({
			contentSecurityPolicyReportOnly: {
				defaultSrc: ["'self'"],
				baseUri: ["'self'"],
				objectSrc: ["'none'"],
				scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
				styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
				fontSrc: ["'self'", 'https://fonts.gstatic.com'],
				imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
				connectSrc: ["'self'"],
				// Direct exposure uses provider-issued origins that are unknown at startup.
				frameSrc:
					deps.sandbox.exposure?.mode === 'proxy' ? ["'self'"] : ["'self'", 'https:', 'http:'],
				workerSrc: ["'self'", 'blob:'],
			},
		}),
	);

	// Serve the prebuilt SPA. API routes (registered inside createApi) are terminal,
	// so they take precedence; everything else falls through to static assets, with
	// a single-page-app fallback to index.html.
	const staticRoot = validatedEnv.MARIMOHUB_STATIC_ROOT ?? './public';
	const spaFallback = serveSpaFallback(staticRoot, validatedEnv.MARIMOHUB_APP_BASE_URL);
	app.get('/', spaFallback);
	app.get('/index.html', spaFallback);
	app.use('/*', serveStaticWithCache({ root: staticRoot }));
	app.get('*', spaFallback);

	// Maintenance + session-lifecycle loops — run on a single replica (the
	// marimohub-maintenance Deployment). The bucket-CAS leases inside are
	// defense-in-depth guards.
	const stops: (() => void)[] = [];
	const runtimeDrains: (() => Promise<void>)[] = [];
	if (validatedEnv.MARIMOHUB_RUN_MAINTENANCE === 'true') {
		const warmPools = startWarmPools(deps, loops);
		if (warmPools) {
			stops.push(warmPools.stop);
			runtimeDrains.push(warmPools.drain);
		}
		stops.push(startMaintenance(deps, wideEvents, loops));
		const stopPreviews = startPreviewPreparation(deps, loops);
		if (stopPreviews) stops.push(stopPreviews);
		const stopLifecycle = startSessionLifecycle(deps, loops);
		if (stopLifecycle) stops.push(stopLifecycle);
		if (deps.jobs) {
			const jobScheduler = startJobScheduler(deps, wideEvents, loops);
			stops.push(jobScheduler.stop);
			runtimeDrains.push(jobScheduler.drain);
		}
	}

	const port = Number(validatedEnv.PORT ?? 3000);
	// Unset listens on every interface, which a container needs to publish the port.
	const hostname = overrides.hostname ?? validatedEnv.MARIMOHUB_BIND_HOST;
	let serverFetch = app.fetch;
	if (deps.sandbox.exposure?.mode === 'proxy') {
		const proxyApp = new Hono();
		const compressProxy = compress({
			contentTypeFilter: (type) =>
				!/^\s*text\/event-stream(?:[;\s]|$)/i.test(type) &&
				COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type),
		});
		for (const prefix of Object.values(SANDBOX_PROXY_PREFIXES)) {
			const path = `${prefix}/*`;
			proxyApp.use(path, compressProxy);
			proxyApp.all(path, (c) => {
				// Node fetch adds accept-encoding when absent. Request identity upstream
				// and negotiate compression using the original client request here.
				const headers = new Headers(c.req.raw.headers);
				headers.set('accept-encoding', 'identity');
				return app.fetch(new Request(c.req.raw, { headers }), c.env);
			});
		}
		// Node bindings in env back getConnInfo for routes behind this wrapper.
		proxyApp.all('*', (c) => app.fetch(c.req.raw, c.env));
		serverFetch = proxyApp.fetch;
	}

	const serverOptions = {
		fetch: serverFetch,
		port,
		...(hostname ? { hostname } : {}),
	};
	const server = serveFn(serverOptions, (info) => {
		const address = info.address.includes(':') ? `[${info.address}]` : info.address;
		logEvent({
			level: 'info',
			event: 'server_started',
			'service.version': buildVersion(validatedEnv),
			address: `http://${address}:${info.port}`,
		});
	});

	// In `proxy` exposure mode, forward `…/proxy/<token>/` WebSocket upgrades to the
	// kernel (the HTTP side is handled inside `app.fetch`). A no-op otherwise.
	attachSandboxProxyUpgrade(server, deps);

	const unregisterSignals: (() => void)[] = [];
	let drainPromise: Promise<void> | undefined;
	const waitForBackgroundTasks = (): Promise<void> => backgroundTasks.drain();
	const closeNotifier = onceAsync(() =>
		deps.notifier ? disposeNotifier(deps.notifier) : undefined,
	);
	const closeDataBrowser = onceAsync(() => deps.dataBrowser?.close?.());
	const shutdownOtel = onceAsync(() => otel?.shutdown());
	const drain = (): Promise<void> => {
		drainPromise ??= (async () => {
			thumbnailDeadline = Date.now() + drainTimeoutMs - 1000;
			for (const unregisterSignal of unregisterSignals.splice(0)) unregisterSignal();
			// Cancel future ticks first. An in-flight sweep still has the remaining drain
			// window to release its lease; the lease TTL is the fallback if it outlives it.
			for (const stopLoop of stops) stopLoop();

			const closed = new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			if ('closeIdleConnections' in server) server.closeIdleConnections();
			const disposeCompute = deps.compute[Symbol.asyncDispose];
			const runtimeDrained = Promise.allSettled([
				// Timed-out ticks can still dispatch jobs until their actual work settles.
				loops
					.drain()
					.then(() =>
						Promise.allSettled(runtimeDrains.map((drain) => Promise.resolve().then(drain))),
					),
				closed.then(waitForBackgroundTasks),
			]);
			const resourcesClosed = Promise.allSettled([
				closed.then(closeDataBrowser),
				runtimeDrained.then(closeNotifier),
				runtimeDrained.then(() => disposeCompute?.call(deps.compute)),
			]);

			// Kubernetes must allow this budget plus the final cleanup window.
			const result = await settleAllWithin([resourcesClosed.then(shutdownOtel)], drainTimeoutMs);
			if (result === 'timed-out') {
				logEvent({ level: 'warn', event: 'drain_timeout', timeoutMs: drainTimeoutMs });
				await settleAllWithin(
					[closeDataBrowser(), waitForBackgroundTasks().then(closeNotifier), shutdownOtel()],
					CLEANUP_TIMEOUT_MS,
				);
			}
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
