import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInterval } from './useInterval';

describe('useInterval', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('runs the callback every delay', () => {
		const cb = vi.fn();
		renderHook(() => useInterval(cb, 1000));
		expect(cb).not.toHaveBeenCalled();
		vi.advanceTimersByTime(3000);
		expect(cb).toHaveBeenCalledTimes(3);
	});

	it('pauses when delay is null', () => {
		const cb = vi.fn();
		renderHook(() => useInterval(cb, null));
		vi.advanceTimersByTime(5000);
		expect(cb).not.toHaveBeenCalled();
	});

	it('invokes the latest callback without resetting the timer', () => {
		const first = vi.fn();
		const second = vi.fn();
		const { rerender } = renderHook(({ cb }) => useInterval(cb, 1000), {
			initialProps: { cb: first },
		});
		vi.advanceTimersByTime(1000);
		expect(first).toHaveBeenCalledTimes(1);

		rerender({ cb: second });
		vi.advanceTimersByTime(1000);
		expect(second).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledTimes(1); // the old closure is not called again
	});

	it('stops the timer on unmount', () => {
		const cb = vi.fn();
		const { unmount } = renderHook(() => useInterval(cb, 1000));
		unmount();
		vi.advanceTimersByTime(3000);
		expect(cb).not.toHaveBeenCalled();
	});
});
