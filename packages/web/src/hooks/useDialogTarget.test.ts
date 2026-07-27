import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDialogTarget } from './useDialogTarget';

interface Row {
	id: string;
}

describe('useDialogTarget', () => {
	it('starts closed with no target', () => {
		const { result } = renderHook(() => useDialogTarget<Row>());
		expect(result.current.target).toBeNull();
		expect(result.current.isOpen).toBe(false);
	});

	it('honors an initial target', () => {
		const row = { id: 'nb-1' };
		const { result } = renderHook(() => useDialogTarget<Row>(row));
		expect(result.current.target).toBe(row);
		expect(result.current.isOpen).toBe(true);
	});

	it('open sets the target and close clears both', () => {
		const row = { id: 'nb-1' };
		const { result } = renderHook(() => useDialogTarget<Row>());

		act(() => result.current.open(row));
		expect(result.current.target).toBe(row);
		expect(result.current.isOpen).toBe(true);

		act(() => result.current.close());
		expect(result.current.target).toBeNull();
		expect(result.current.isOpen).toBe(false);
	});

	it('replaces the target when opened again', () => {
		const first = { id: 'nb-1' };
		const second = { id: 'nb-2' };
		const { result } = renderHook(() => useDialogTarget<Row>());

		act(() => result.current.open(first));
		act(() => result.current.open(second));
		expect(result.current.target).toBe(second);
		expect(result.current.isOpen).toBe(true);
	});

	it('is open for falsy-but-valid targets', () => {
		const numeric = renderHook(() => useDialogTarget<number>());
		act(() => numeric.result.current.open(0));
		expect(numeric.result.current.target).toBe(0);
		expect(numeric.result.current.isOpen).toBe(true);

		const text = renderHook(() => useDialogTarget<string>());
		act(() => text.result.current.open(''));
		expect(text.result.current.target).toBe('');
		expect(text.result.current.isOpen).toBe(true);
	});

	it('keeps stable callback identities across renders', () => {
		const { result, rerender } = renderHook(() => useDialogTarget<Row>());
		const first = result.current;

		act(() => result.current.open({ id: 'nb-1' }));
		rerender();

		expect(result.current.open).toBe(first.open);
		expect(result.current.close).toBe(first.close);
	});
});
