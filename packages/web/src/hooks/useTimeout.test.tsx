import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTimeout } from './useTimeout';

function setup(delayMs: number | null = 1000) {
	const callback = vi.fn();
	return {
		callback,
		...renderHook(({ callback, delayMs }) => useTimeout(callback, delayMs), {
			initialProps: { callback, delayMs },
		}),
	};
}

describe('useTimeout', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('runs once after the full delay', () => {
		const { callback } = setup();
		vi.advanceTimersByTime(999);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5000);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('uses the latest callback without postponing or rearming the timeout', () => {
		const { callback, rerender } = setup();
		vi.advanceTimersByTime(750);
		const latest = vi.fn();
		rerender({ callback: latest, delayMs: 1000 });
		vi.advanceTimersByTime(250);
		expect(latest).toHaveBeenCalledTimes(1);
		expect(callback).not.toHaveBeenCalled();
		rerender({ callback, delayMs: 1000 });
		vi.advanceTimersByTime(2000);
		expect(callback).not.toHaveBeenCalled();
	});

	it('cancels a pending timeout with null and starts a full delay when enabled again', () => {
		const { callback, rerender } = setup();
		vi.advanceTimersByTime(750);
		rerender({ callback, delayMs: null });
		vi.advanceTimersByTime(5000);
		expect(callback).not.toHaveBeenCalled();
		rerender({ callback, delayMs: 1000 });
		vi.advanceTimersByTime(999);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('does not schedule while disabled', () => {
		const { callback } = setup(null);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(callback).not.toHaveBeenCalled();
	});

	it('replaces the pending timeout when the delay changes', () => {
		const { callback, rerender } = setup();
		vi.advanceTimersByTime(750);
		rerender({ callback, delayMs: 2000 });
		vi.advanceTimersByTime(1999);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('schedules a zero delay asynchronously', () => {
		const { callback } = setup(0);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('clears the pending timeout on unmount', () => {
		const { callback, unmount } = setup();
		unmount();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(callback).not.toHaveBeenCalled();
	});

	it('fires once under Strict Mode effect replay', () => {
		const callback = vi.fn();
		renderHook(() => useTimeout(callback, 1000), { wrapper: StrictMode });
		vi.advanceTimersByTime(1000);
		expect(callback).toHaveBeenCalledTimes(1);
	});
});
