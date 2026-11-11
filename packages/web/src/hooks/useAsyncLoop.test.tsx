import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred } from '@/test/deferred';
import { useAsyncLoop } from './useAsyncLoop';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

it('waits for each step before delaying again and stops on null', async () => {
	const first = deferred<number | null>();
	const step = vi
		.fn<(state: number, signal: AbortSignal) => Promise<number | null>>()
		.mockReturnValueOnce(first.promise)
		.mockResolvedValueOnce(null);
	const onError = vi.fn();
	renderHook(() => useAsyncLoop({ key: 'one', initial: 0, delay: () => 100, step, onError }));
	await advance(100);
	expect(step).toHaveBeenCalledOnce();
	await advance(500);
	expect(step).toHaveBeenCalledOnce();
	await act(async () => first.resolve(1));
	await advance(99);
	expect(step).toHaveBeenCalledOnce();
	await advance(1);
	expect(step.mock.calls[1]?.[0]).toBe(1);
	await advance(500);
	expect(step).toHaveBeenCalledTimes(2);
	expect(onError).not.toHaveBeenCalled();
});

it('does not duplicate steps in StrictMode and cancels sleeping on unmount', async () => {
	const step = vi.fn(async (state: number) => state + 1);
	const { unmount } = renderHook(
		() => useAsyncLoop({ key: 'one', initial: 0, delay: () => 100, step, onError: vi.fn() }),
		{ reactStrictMode: true },
	);
	await advance(100);
	expect(step).toHaveBeenCalledOnce();
	unmount();
	await advance(500);
	expect(step).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it('aborts replaced work, resets state, and ignores late rejection', async () => {
	const first = deferred<number | null>();
	const step = vi
		.fn<(state: number, signal: AbortSignal) => Promise<number | null>>()
		.mockReturnValueOnce(first.promise)
		.mockResolvedValueOnce(null);
	const onError = vi.fn();
	const { rerender } = renderHook(
		({ key }) => useAsyncLoop({ key, initial: 0, delay: () => 100, step, onError }),
		{ initialProps: { key: 'one' as string | null } },
	);
	await advance(100);
	const signal = step.mock.calls[0][1];
	rerender({ key: 'two' });
	expect(signal.aborted).toBe(true);
	await act(async () => first.reject(new Error('Late network error')));
	await advance(100);
	expect(step.mock.calls[1]?.[0]).toBe(0);
	expect(onError).not.toHaveBeenCalled();
	rerender({ key: null });
	await advance(500);
	expect(step).toHaveBeenCalledTimes(2);
});

it('aborts pending work on unmount without reporting its late rejection', async () => {
	const pending = deferred<number | null>();
	const step = vi.fn((_state: number, _signal: AbortSignal) => pending.promise);
	const onError = vi.fn();
	const { unmount } = renderHook(() =>
		useAsyncLoop({ key: 'one', initial: 0, delay: () => 0, step, onError }),
	);
	await advance(0);
	const signal = step.mock.calls[0][1];
	unmount();
	expect(signal.aborted).toBe(true);
	await act(async () => pending.reject(new Error('Late network error')));
	expect(onError).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it('disables pending work and starts fresh when the same key is enabled again', async () => {
	const old = deferred<number | null>();
	const step = vi
		.fn<(state: number, signal: AbortSignal) => Promise<number | null>>()
		.mockReturnValueOnce(old.promise)
		.mockResolvedValue(null);
	const onError = vi.fn();
	const { rerender } = renderHook(
		({ key }) => useAsyncLoop({ key, initial: 0, delay: () => 100, step, onError }),
		{
			initialProps: { key: 'one' as string | null },
		},
	);
	await advance(100);
	rerender({ key: null });
	expect(step.mock.calls[0][1].aborted).toBe(true);
	await act(async () => old.resolve(99));
	await advance(1000);
	expect(step).toHaveBeenCalledOnce();
	rerender({ key: 'one' });
	await advance(100);
	expect(step.mock.calls[1]?.[0]).toBe(0);
	expect(onError).not.toHaveBeenCalled();
});

it('uses new callbacks without resetting a scheduled delay or loop state', async () => {
	const oldStep = vi.fn(async (state: number) => state + 1);
	const newStep = vi.fn(async (state: number) => state + 1);
	const { rerender } = renderHook(
		({ step, delay }) =>
			useAsyncLoop({ key: 'one', initial: 0, delay: () => delay, step, onError: vi.fn() }),
		{ initialProps: { step: oldStep, delay: 100 } },
	);
	await advance(50);
	rerender({ step: newStep, delay: 200 });
	await advance(50);
	expect(oldStep).not.toHaveBeenCalled();
	expect(newStep.mock.calls[0]?.[0]).toBe(0);
	await advance(199);
	expect(newStep).toHaveBeenCalledOnce();
	await advance(1);
	expect(newStep.mock.calls[1]?.[0]).toBe(1);
});

it.each(['request', 'delay'])('reports a %s failure once and stops', async (failure) => {
	const error = new Error('Unavailable');
	const step = vi.fn(async () => {
		throw error;
	});
	const onError = vi.fn();
	renderHook(() =>
		useAsyncLoop({
			key: 'one',
			initial: 0,
			delay: () => (failure === 'delay' ? -1 : 100),
			step,
			onError,
		}),
	);
	await advance(1000);
	expect(onError).toHaveBeenCalledOnce();
	expect(step).toHaveBeenCalledTimes(failure === 'delay' ? 0 : 1);
	expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});
