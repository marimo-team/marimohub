import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGeneration } from './useGeneration';

describe('useGeneration', () => {
	it('starts at generation 0', () => {
		const { result } = renderHook(() => useGeneration());
		expect(result.current.current()).toBe(0);
		expect(result.current.isCurrent(0)).toBe(true);
	});

	it('bump increments and returns the new generation', () => {
		const { result } = renderHook(() => useGeneration());
		expect(result.current.bump()).toBe(1);
		expect(result.current.bump()).toBe(2);
		expect(result.current.current()).toBe(2);
	});

	it('isCurrent is true only for the latest generation', () => {
		const { result } = renderHook(() => useGeneration());
		result.current.bump();
		result.current.bump();

		expect(result.current.isCurrent(2)).toBe(true);
		expect(result.current.isCurrent(1)).toBe(false);
		expect(result.current.isCurrent(0)).toBe(false);
		expect(result.current.isCurrent(3)).toBe(false);
	});

	it('marks work captured before a bump as stale', () => {
		const { result } = renderHook(() => useGeneration());

		// A poll in flight when the user restarts must not write its late response.
		const inFlight = result.current.current();
		expect(result.current.isCurrent(inFlight)).toBe(true);

		const restarted = result.current.bump();

		expect(result.current.isCurrent(inFlight)).toBe(false);
		expect(result.current.isCurrent(restarted)).toBe(true);
	});

	it('keeps a stable handle across renders', () => {
		const { result, rerender } = renderHook(() => useGeneration());
		const first = result.current;

		result.current.bump();
		rerender();

		expect(result.current).toBe(first);
		expect(result.current.current()).toBe(1);
	});
});
