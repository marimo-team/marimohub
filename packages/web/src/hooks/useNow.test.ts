import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

const START = 1_700_000_000_000;

describe('useNow', () => {
	let clock = START;

	// The stubbed `Date.now` and the fake timers are advanced together so the
	// timestamp the hook reads matches the tick that woke it.
	function advance(ms: number) {
		clock += ms;
		act(() => {
			vi.advanceTimersByTime(ms);
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		clock = START;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('returns the current timestamp', () => {
		const { result } = renderHook(() => useNow());
		expect(result.current).toBe(START);
	});

	it('advances on every tick', () => {
		const { result } = renderHook(() => useNow(1000));

		advance(1000);
		expect(result.current).toBe(START + 1000);

		advance(1000);
		expect(result.current).toBe(START + 2000);

		advance(3000);
		expect(result.current).toBe(START + 5000);
	});

	it('honors a custom interval', () => {
		const { result } = renderHook(() => useNow(5000));

		advance(4000);
		expect(result.current).toBe(START);

		advance(1000);
		expect(result.current).toBe(START + 5000);
	});

	it('freezes at the value it last read when the interval is null', () => {
		const { result } = renderHook(() => useNow(null));
		expect(result.current).toBe(START);

		advance(60_000);
		expect(result.current).toBe(START);
	});

	it('stops reading the clock after unmount', () => {
		const { result, unmount } = renderHook(() => useNow(1000));
		advance(1000);
		const last = result.current;

		unmount();
		advance(10_000);
		expect(result.current).toBe(last);
	});
});
