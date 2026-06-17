import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDisclosure } from './useDisclosure';

describe('useDisclosure', () => {
	it('defaults to closed', () => {
		const { result } = renderHook(() => useDisclosure());
		expect(result.current.isOpen).toBe(false);
	});

	it('honors the initial value', () => {
		const { result } = renderHook(() => useDisclosure(true));
		expect(result.current.isOpen).toBe(true);
	});

	it('open / close / toggle move the flag', () => {
		const { result } = renderHook(() => useDisclosure());

		act(() => result.current.open());
		expect(result.current.isOpen).toBe(true);

		act(() => result.current.close());
		expect(result.current.isOpen).toBe(false);

		act(() => result.current.toggle());
		expect(result.current.isOpen).toBe(true);

		act(() => result.current.setOpen(false));
		expect(result.current.isOpen).toBe(false);
	});

	it('keeps stable callback identities across renders', () => {
		const { result, rerender } = renderHook(() => useDisclosure());
		const first = result.current;
		act(() => result.current.open());
		rerender();
		expect(result.current.open).toBe(first.open);
		expect(result.current.close).toBe(first.close);
		expect(result.current.toggle).toBe(first.toggle);
	});
});
