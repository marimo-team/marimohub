import { afterEach, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { SessionLifetimeConfig } from '@marimo-hub/api';
import { Millis } from '@marimo-hub/core';

export const SESSION_SWEEP_INTERVAL_MS = Millis.seconds(60);

export function makeSessionLifetime(
	overrides: Partial<SessionLifetimeConfig> = {},
): SessionLifetimeConfig {
	return {
		maxLifetimeMs: Millis.hours(4),
		idleTimeoutMsByMode: { edit: Millis.minutes(30), app: Millis.minutes(30) },
		snapshotIntervalMs: Millis.minutes(2),
		extensionMs: Millis.minutes(30),
		connectionAware: false,
		sweepIntervalMs: SESSION_SWEEP_INTERVAL_MS,
		...overrides,
	};
}

/** Flush the attempt a loop starts on registration, whose awaits are microtasks. */
export async function flushRun(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

export function parseLoggedEvents(logSpy: {
	mock: { calls: unknown[][] };
}): Record<string, unknown>[] {
	return logSpy.mock.calls.map(
		(call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
	);
}

type Stoppable = (() => void) | { stop(): void } | undefined;

export interface LoopHarness {
	logSpy: MockInstance<typeof console.log>;
	events(): Record<string, unknown>[];
	/** Stop `handle` after the test, before real timers come back. */
	track<T extends Stoppable>(handle: T): T;
}

/** Fake timers, captured `console.log` wide events, and loop teardown for each test. */
export function useLoopHarness(): LoopHarness {
	let stops: Stoppable[] = [];
	const harness: LoopHarness = {
		logSpy: undefined as never,
		events: () => parseLoggedEvents(harness.logSpy),
		track(handle) {
			stops.push(handle);
			return handle;
		},
	};
	beforeEach(() => {
		stops = [];
		vi.useFakeTimers();
		harness.logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		for (const handle of stops) {
			if (typeof handle === 'function') handle();
			else handle?.stop();
		}
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	return harness;
}
