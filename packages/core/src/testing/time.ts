import { vi } from 'vitest';

/**
 * Install fake timers anchored at `at` (default 0). Returns handles to move the
 * clock and to restore real timers — wire `restore` into `afterEach`.
 */
export function useFakeClock(at = 0) {
	vi.useFakeTimers();
	vi.setSystemTime(at);
	return {
		set: (ms: number) => vi.setSystemTime(ms),
		advance: (ms: number) => vi.setSystemTime(Date.now() + ms),
		restore: () => vi.useRealTimers(),
	};
}

/**
 * Switch to fake timers and jump the clock forward `ms` from the current time.
 * For one-off "fast-forward past a TTL" assertions; pair with `restoreClock()`.
 */
export function advanceTime(ms: number): void {
	vi.useFakeTimers();
	vi.setSystemTime(Date.now() + ms);
}

/** Restore real timers (inverse of `useFakeClock`/`advanceTime`). */
export function restoreClock(): void {
	vi.useRealTimers();
}
