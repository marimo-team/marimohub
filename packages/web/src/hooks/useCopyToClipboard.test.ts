import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { useCopyToClipboard } from './useCopyToClipboard';

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const writeText = vi.fn<(value: string) => Promise<void>>();

function installClipboard() {
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
		writable: true,
	});
}

describe('useCopyToClipboard', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		writeText.mockReset().mockResolvedValue(undefined);
		vi.mocked(toast.error).mockClear();
		installClipboard();
	});

	afterEach(() => {
		vi.useRealTimers();
		Reflect.deleteProperty(navigator, 'clipboard');
	});

	async function copy(copyFn: (value: string) => Promise<boolean>, value: string) {
		let landed: boolean | undefined;
		await act(async () => {
			landed = await copyFn(value);
		});
		return landed;
	}

	it('writes the value to the clipboard and resolves true', async () => {
		const { result } = renderHook(() => useCopyToClipboard());
		expect(result.current.copied).toBe(false);

		const landed = await copy(result.current.copy, 'mhub_pat_abc');

		expect(landed).toBe(true);
		expect(writeText).toHaveBeenCalledWith('mhub_pat_abc');
		expect(result.current.copied).toBe(true);
	});

	it('resets copied after the delay', async () => {
		const { result } = renderHook(() => useCopyToClipboard(1500));
		await copy(result.current.copy, 'value');

		act(() => {
			vi.advanceTimersByTime(1499);
		});
		expect(result.current.copied).toBe(true);

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(result.current.copied).toBe(false);
	});

	it('honors a custom reset delay', async () => {
		const { result } = renderHook(() => useCopyToClipboard(100));
		await copy(result.current.copy, 'value');

		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(result.current.copied).toBe(false);
	});

	it('restarts the window when copying again before the timer expires', async () => {
		const { result } = renderHook(() => useCopyToClipboard(1500));
		await copy(result.current.copy, 'first');

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		await copy(result.current.copy, 'second');

		// Past the first copy's deadline, but the second copy restarted the clock.
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(result.current.copied).toBe(true);

		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(result.current.copied).toBe(false);
	});

	it('resolves false, stays uncopied, and toasts when the write is rejected', async () => {
		writeText.mockRejectedValue(new Error('not allowed'));
		const { result } = renderHook(() => useCopyToClipboard());

		const landed = await copy(result.current.copy, 'value');

		expect(landed).toBe(false);
		expect(result.current.copied).toBe(false);
		expect(toast.error).toHaveBeenCalledWith('Could not copy to clipboard');
	});

	it('clears the acknowledgement when a copy fails inside a previous copy’s window', async () => {
		const { result } = renderHook(() => useCopyToClipboard(1500));
		await copy(result.current.copy, 'first');
		expect(result.current.copied).toBe(true);

		writeText.mockRejectedValue(new Error('not allowed'));
		await copy(result.current.copy, 'second');

		// The ✓ must not linger from the successful copy over a failed one.
		expect(result.current.copied).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not fire the reset timer after unmount', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { result, unmount } = renderHook(() => useCopyToClipboard(1500));
		await copy(result.current.copy, 'value');

		unmount();
		expect(vi.getTimerCount()).toBe(0);

		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});
});
