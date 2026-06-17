import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('returns the initial value immediately', () => {
		const { result } = renderHook(() => useDebouncedValue('a', 200));
		expect(result.current).toBe('a');
	});

	it('only surfaces the latest value after the delay elapses', () => {
		const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
			initialProps: { value: 'a' },
		});

		rerender({ value: 'ab' });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		rerender({ value: 'abc' });
		act(() => {
			vi.advanceTimersByTime(150);
		});
		// 'ab' never surfaced: its timer was reset by 'abc'.
		expect(result.current).toBe('a');

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(result.current).toBe('abc');
	});
});
