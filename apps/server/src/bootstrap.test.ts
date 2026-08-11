import type { ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiDeps } from '@marimo-hub/api';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { ConfigError } from '@marimo-hub/config';
import { bootstrap } from './bootstrap';
import type { BootstrapOverrides } from './bootstrap';
import { startMaintenance, startSessionLifecycle } from './cron';
import type { OtelHandle } from './otel';

vi.mock('./cron', () => ({
	startMaintenance: vi.fn(() => vi.fn()),
	startSessionLifecycle: vi.fn(() => vi.fn()),
}));

type Signal = 'SIGTERM' | 'SIGINT';
type PreflightReport = Awaited<ReturnType<NonNullable<ApiDeps['preflight']>>>;

const BASE_ENV = { MARIMOHUB_STATIC_ROOT: './public' };

function fakeServer(closeImmediately = true) {
	const close = vi.fn((callback?: () => void) => {
		if (closeImmediately) callback?.();
	});
	const closeIdleConnections = vi.fn();
	const on = vi.fn();
	const server = { close, closeIdleConnections, on } as unknown as ServerType;
	return { server, close, closeIdleConnections };
}

function makeHarness(
	deps: ApiDeps,
	options: { closeImmediately?: boolean; otel?: OtelHandle | null } = {},
) {
	const server = fakeServer(options.closeImmediately);
	const createDeps = vi.fn(() => deps);
	const serveFn = vi.fn(() => server.server);
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

	it('flushes OpenTelemetry during drain', async () => {
		const shutdown = vi.fn().mockResolvedValue(undefined);
		const harness = makeHarness(deps, {
			otel: { tracing: false, metrics: false, shutdown },
		});
		await bootstrap(BASE_ENV, harness.overrides);

		harness.signals.get('SIGTERM')?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(shutdown).toHaveBeenCalledOnce();
		expect(harness.exit).toHaveBeenCalledWith(0);
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

	it('exits on a configuration error without serving', async () => {
		const harness = makeHarness(deps);
		harness.createDeps.mockImplementationOnce(() => {
			throw new ConfigError('missing storage backend');
		});

		await expect(bootstrap(BASE_ENV, harness.overrides)).resolves.toBeUndefined();
		expect(harness.exit).toHaveBeenCalledWith(1);
		expect(harness.serveFn).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Configuration error: missing storage backend'),
		);
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
