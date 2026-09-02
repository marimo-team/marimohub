import type { ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiDeps } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ConfigError } from '@marimo-hub/config';
import { bootstrap } from './bootstrap';
import type { BootstrapOverrides } from './bootstrap';
import { startJobScheduler, startMaintenance, startSessionLifecycle } from './cron';
import type { OtelHandle } from './otel';

vi.mock('./cron', () => ({
	startMaintenance: vi.fn(() => vi.fn()),
	startSessionLifecycle: vi.fn(() => vi.fn()),
	startJobScheduler: vi.fn(() => ({ stop: vi.fn(), drain: vi.fn(async () => {}) })),
}));

type Signal = 'SIGTERM' | 'SIGINT';
type PreflightReport = Awaited<ReturnType<NonNullable<ApiDeps['preflight']>>>;

const BASE_ENV = { MARIMOHUB_STATIC_ROOT: './public' };

function fakeServer(closeImmediately = true) {
	let finishClose: (() => void) | undefined;
	const close = vi.fn((callback?: () => void) => {
		if (closeImmediately) callback?.();
		else finishClose = callback;
	});
	const closeIdleConnections = vi.fn();
	const on = vi.fn();
	const server = { close, closeIdleConnections, on } as unknown as ServerType;
	return { server, close, closeIdleConnections, finishClose: () => finishClose?.() };
}

function makeHarness(
	deps: ApiDeps,
	options: { closeImmediately?: boolean; otel?: OtelHandle | null } = {},
) {
	const server = fakeServer(options.closeImmediately);
	const createDeps = vi.fn<NonNullable<BootstrapOverrides['createDeps']>>(() => deps);
	const serveFn = vi.fn<NonNullable<BootstrapOverrides['serveFn']>>(() => server.server);
	const exit = vi.fn<(code: number) => void>();
	const signals = new Map<Signal, () => void>();
	const registerSignal = vi.fn((signal: Signal, handler: () => void) => {
		signals.set(signal, handler);
		return () => signals.delete(signal);
	});
	const startOtelFn = vi.fn(() => options.otel ?? null);
	const overrides = {
		createDeps,
		serveFn,
		exit,
		registerSignal,
		startOtelFn,
	} satisfies BootstrapOverrides;
	return { ...server, createDeps, serveFn, exit, signals, startOtelFn, overrides };
}

describe('bootstrap', () => {
	let deps: ApiDeps;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		deps = makeTestDeps(await createInitializedBucket());
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(startMaintenance).mockImplementation(() => vi.fn());
		vi.mocked(startSessionLifecycle).mockImplementation(() => vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('exits on a fatal preflight result without serving', async () => {
		const report: PreflightReport = {
			ok: false,
			fatal: true,
			checks: [
				{
					name: 'storage',
					status: 'fail',
					fatal: true,
					message: 'conditional writes ignored',
				},
			],
		};
		deps.preflight = async () => report;
		const harness = makeHarness(deps);

		await expect(bootstrap(BASE_ENV, harness.overrides)).resolves.toBeUndefined();
		expect(harness.exit).toHaveBeenCalledWith(1);
		expect(harness.serveFn).not.toHaveBeenCalled();
	});

	it('serves after a non-fatal preflight failure', async () => {
		const report: PreflightReport = {
			ok: false,
			fatal: false,
			checks: [
				{
					name: 'storage',
					status: 'fail',
					fatal: false,
					message: 'storage unavailable',
				},
			],
		};
		deps.preflight = async () => report;
		const harness = makeHarness(deps);

		await expect(bootstrap(BASE_ENV, harness.overrides)).resolves.toBeDefined();
		expect(harness.serveFn).toHaveBeenCalledOnce();
		expect(harness.exit).not.toHaveBeenCalled();
	});

	it('passes the port and fetch handler as the exact default serve options', async () => {
		const harness = makeHarness(deps);

		await bootstrap({ ...BASE_ENV, PORT: '4100' }, harness.overrides);

		expect(harness.serveFn).toHaveBeenCalledWith(
			{ fetch: expect.any(Function), port: 4100 },
			expect.any(Function),
		);
	});

	it('passes an explicit hostname to the server', async () => {
		const harness = makeHarness(deps);

		await bootstrap(BASE_ENV, { ...harness.overrides, hostname: '127.0.0.1' });

		expect(harness.serveFn).toHaveBeenCalledWith(
			{ fetch: expect.any(Function), hostname: '127.0.0.1', port: 3000 },
			expect.any(Function),
		);
	});

	it.each([
		[{ address: '127.0.0.1', family: 'IPv4' as const, port: 3000 }, 'http://127.0.0.1:3000'],
		[{ address: '::1', family: 'IPv6' as const, port: 4100 }, 'http://[::1]:4100'],
	])('logs the concrete bound address %#', async (address, expected) => {
		const harness = makeHarness(deps);
		await bootstrap(BASE_ENV, harness.overrides);

		const onListening = harness.serveFn.mock.calls[0][1];
		onListening?.(address);

		expect(console.log).toHaveBeenCalledWith(`[marimohub] server listening on ${expected}`);
	});

	it('prepares dependencies before preflight and serving', async () => {
		const order: string[] = [];
		deps.preflight = async () => {
			order.push('preflight');
			return { ok: true, fatal: false, checks: [] };
		};
		const harness = makeHarness(deps);
		harness.serveFn.mockImplementationOnce(() => {
			order.push('serve');
			return harness.server;
		});

		await bootstrap(BASE_ENV, {
			...harness.overrides,
			prepareDeps: async () => {
				order.push('prepare');
			},
		});

		expect(order).toEqual(['prepare', 'preflight', 'serve']);
	});

	it('registers both drain signals without OpenTelemetry', async () => {
		const harness = makeHarness(deps);

		await bootstrap(BASE_ENV, harness.overrides);

		expect([...harness.signals.keys()]).toEqual(['SIGTERM', 'SIGINT']);
	});

	it('closes connections and exits at the drain deadline', async () => {
		const harness = makeHarness(deps, { closeImmediately: false });
		await bootstrap(BASE_ENV, harness.overrides);

		harness.signals.get('SIGTERM')?.();

		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.closeIdleConnections).toHaveBeenCalledOnce();
		expect(harness.exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(harness.exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.exit).toHaveBeenCalledWith(0);
	});

	it('logs a warning and still exits 0 when the drain times out', async () => {
		const harness = makeHarness(deps, { closeImmediately: false });
		await bootstrap(BASE_ENV, harness.overrides);

		harness.signals.get('SIGTERM')?.();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(harness.exit).toHaveBeenCalledWith(0);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"event":"drain_timeout"'));
	});

	it('logs an error and exits non-zero when the drain rejects', async () => {
		vi.mocked(startMaintenance).mockReturnValueOnce(() => {
			throw new Error('stop failed');
		});
		const harness = makeHarness(deps);
		await bootstrap({ ...BASE_ENV, MARIMOHUB_RUN_MAINTENANCE: 'true' }, harness.overrides);

		harness.signals.get('SIGTERM')?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"event":"drain_failed"'));
		expect(harness.exit).toHaveBeenCalledWith(1);
		expect(harness.exit).not.toHaveBeenCalledWith(0);
	});

	it('flushes OpenTelemetry during drain', async () => {
		const shutdown = vi.fn().mockResolvedValue(undefined);
		const harness = makeHarness(deps, {
			otel: { tracing: false, metrics: false, logs: false, shutdown },
		});
		await bootstrap(BASE_ENV, harness.overrides);

		harness.signals.get('SIGTERM')?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(shutdown).toHaveBeenCalledOnce();
		expect(harness.exit).toHaveBeenCalledWith(0);
	});

	it('closes the data-preview backend after active HTTP requests have drained', async () => {
		const closePreview = vi.fn().mockResolvedValue(undefined);
		deps.dataBrowser = { preview: true, close: closePreview };
		const harness = makeHarness(deps, { closeImmediately: false });
		const handle = await bootstrap(BASE_ENV, harness.overrides);

		const draining = handle?.drain();
		expect(harness.close).toHaveBeenCalledOnce();
		expect(closePreview).not.toHaveBeenCalled();

		harness.finishClose();
		await draining;
		expect(closePreview).toHaveBeenCalledOnce();
	});

	it('closes the data-preview backend when WebSockets outlive the drain deadline', async () => {
		const closePreview = vi.fn().mockResolvedValue(undefined);
		deps.dataBrowser = { preview: true, close: closePreview };
		const harness = makeHarness(deps, { closeImmediately: false });
		const handle = await bootstrap(BASE_ENV, harness.overrides);

		const draining = handle?.drain();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(closePreview).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await draining;
		expect(closePreview).toHaveBeenCalledOnce();
	});

	it('exits after a bounded wait when forced data-preview cleanup does not finish', async () => {
		const closePreview = vi.fn(() => new Promise<void>(() => {}));
		deps.dataBrowser = { preview: true, close: closePreview };
		const harness = makeHarness(deps, { closeImmediately: false });
		await bootstrap(BASE_ENV, harness.overrides);

		harness.signals.get('SIGTERM')?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(closePreview).toHaveBeenCalledOnce();
		expect(harness.exit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(9_999);
		expect(harness.exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.exit).toHaveBeenCalledWith(0);
	});

	it('disposes compute during drain', async () => {
		const dispose = vi.fn().mockResolvedValue(undefined);
		const compute = { ...deps.compute, [Symbol.asyncDispose]: dispose };
		const harness = makeHarness({ ...deps, compute });
		const handle = await bootstrap(BASE_ENV, harness.overrides);

		await handle?.drain();
		await handle?.drain();

		expect(dispose).toHaveBeenCalledOnce();
	});

	it('disposes compute only after the job scheduler is drained', async () => {
		let finishSchedulerDrain!: () => void;
		const schedulerDrain = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSchedulerDrain = resolve;
				}),
		);
		const stopScheduler = vi.fn();
		vi.mocked(startJobScheduler).mockReturnValueOnce({
			stop: stopScheduler,
			drain: schedulerDrain,
		});
		const dispose = vi.fn().mockResolvedValue(undefined);
		const compute = { ...deps.compute, [Symbol.asyncDispose]: dispose };
		const harness = makeHarness({ ...deps, compute });
		const handle = await bootstrap(
			{ ...BASE_ENV, MARIMOHUB_RUN_MAINTENANCE: 'true' },
			harness.overrides,
		);

		const draining = handle?.drain();
		await Promise.resolve();
		expect(stopScheduler).toHaveBeenCalledOnce();
		expect(schedulerDrain).toHaveBeenCalledOnce();
		expect(stopScheduler.mock.invocationCallOrder[0]).toBeLessThan(
			schedulerDrain.mock.invocationCallOrder[0],
		);
		expect(dispose).not.toHaveBeenCalled();

		finishSchedulerDrain();
		await draining;
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('tracks background deliveries and disposes their notifier after they settle', async () => {
		let finishDelivery: (() => void) | undefined;
		const delivery = new Promise<void>((resolve) => {
			finishDelivery = resolve;
		});
		const disposeNotifier = vi.fn(async () => {});
		deps.notifier = {
			deliver: vi.fn(async () => 'delivered' as const),
			[Symbol.asyncDispose]: disposeNotifier,
		};
		const harness = makeHarness(deps);
		const handle = await bootstrap(BASE_ENV, harness.overrides);
		deps.backgroundTasks?.defer(delivery);

		let drained = false;
		const draining = handle?.drain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		expect(disposeNotifier).not.toHaveBeenCalled();

		finishDelivery?.();
		await draining;
		expect(disposeNotifier).toHaveBeenCalledOnce();
	});

	it('does not close the notifier underneath a stuck background delivery', async () => {
		const closeNotifier = vi.fn();
		deps.notifier = { deliver: vi.fn(async () => 'delivered' as const), close: closeNotifier };
		const harness = makeHarness(deps, { closeImmediately: false });
		const handle = await bootstrap(BASE_ENV, harness.overrides);
		deps.backgroundTasks?.defer(new Promise<void>(() => {}));

		const draining = handle?.drain();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(closeNotifier).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(closeNotifier).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		await draining;
		expect(closeNotifier).not.toHaveBeenCalled();
	});

	it('closes the notifier only once across repeated drains', async () => {
		const closeNotifier = vi.fn();
		deps.notifier = { deliver: vi.fn(async () => 'delivered' as const), close: closeNotifier };
		const harness = makeHarness(deps);
		const handle = await bootstrap(BASE_ENV, harness.overrides);

		await handle?.drain();
		await handle?.drain();

		expect(closeNotifier).toHaveBeenCalledOnce();
	});

	it.each([
		['starts', 'true', 1],
		['does not start', undefined, 0],
	] as const)('%s maintenance loops when enabled is %s', async (_label, enabled, calls) => {
		const harness = makeHarness(deps);
		await bootstrap({ ...BASE_ENV, MARIMOHUB_RUN_MAINTENANCE: enabled }, harness.overrides);

		expect(startMaintenance).toHaveBeenCalledTimes(calls);
		expect(startSessionLifecycle).toHaveBeenCalledTimes(calls);
	});

	it('starts the job scheduler with maintenance only when jobs are on', async () => {
		await bootstrap(BASE_ENV, makeHarness(deps).overrides);
		expect(startJobScheduler).not.toHaveBeenCalled();

		await bootstrap(
			{ ...BASE_ENV, MARIMOHUB_RUN_MAINTENANCE: 'true' },
			makeHarness(deps).overrides,
		);
		expect(startJobScheduler).toHaveBeenCalledOnce();

		vi.mocked(startJobScheduler).mockClear();
		await bootstrap(
			{ ...BASE_ENV, MARIMOHUB_RUN_MAINTENANCE: 'true' },
			makeHarness({ ...deps, jobs: undefined }).overrides,
		);
		expect(startJobScheduler).not.toHaveBeenCalled();
	});

	it('cancels maintenance loops before draining connections', async () => {
		const stopMaintenance = vi.fn();
		const stopLifecycle = vi.fn();
		vi.mocked(startMaintenance).mockReturnValueOnce(stopMaintenance);
		vi.mocked(startSessionLifecycle).mockReturnValueOnce(stopLifecycle);
		const harness = makeHarness(deps);
		await bootstrap({ ...BASE_ENV, MARIMOHUB_RUN_MAINTENANCE: 'true' }, harness.overrides);

		harness.signals.get('SIGTERM')?.();

		expect(stopMaintenance).toHaveBeenCalledOnce();
		expect(stopLifecycle).toHaveBeenCalledOnce();
		expect(stopMaintenance.mock.invocationCallOrder[0]).toBeLessThan(
			harness.close.mock.invocationCallOrder[0],
		);
	});

	it.each([
		[
			'synchronous',
			() => {
				throw new ConfigError('missing storage backend');
			},
		],
		[
			'asynchronous',
			async () => {
				throw new ConfigError('missing storage backend');
			},
		],
	] as const)('exits on a %s configuration error without serving', async (_mode, fail) => {
		const harness = makeHarness(deps);
		harness.createDeps.mockImplementationOnce(fail);

		await expect(bootstrap(BASE_ENV, harness.overrides)).resolves.toBeUndefined();
		expect(harness.exit).toHaveBeenCalledWith(1);
		expect(harness.serveFn).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Configuration error: missing storage backend'),
		);
	});

	it('awaits asynchronous dependency creation before serving', async () => {
		const harness = makeHarness(deps);
		harness.createDeps.mockImplementationOnce(async () => deps);

		await bootstrap(BASE_ENV, harness.overrides);

		expect(harness.serveFn).toHaveBeenCalledOnce();
	});

	it('exits on invalid server-owned environment without creating adapters', async () => {
		const harness = makeHarness(deps);

		await expect(
			bootstrap({ ...BASE_ENV, PORT: 'not-a-port' }, harness.overrides),
		).resolves.toBeUndefined();
		expect(harness.exit).toHaveBeenCalledWith(1);
		expect(harness.createDeps).not.toHaveBeenCalled();
		expect(harness.serveFn).not.toHaveBeenCalled();
	});

	it('can be drained with await using without exiting the process', async () => {
		const harness = makeHarness(deps);

		{
			await using handle = await bootstrap(BASE_ENV, harness.overrides);
			expect(handle?.server).toBe(harness.server);
		}

		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.exit).not.toHaveBeenCalled();
		expect(harness.signals.size).toBe(0);
	});
});
