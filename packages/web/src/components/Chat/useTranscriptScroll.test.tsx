import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { UIEvent } from 'react';
import { useTranscriptScroll } from './useTranscriptScroll';

function transcriptElement() {
	const element = document.createElement('section');
	Object.defineProperties(element, {
		scrollHeight: { value: 2000, writable: true, configurable: true },
		clientHeight: { value: 400, writable: true, configurable: true },
		scrollTop: { value: 1600, writable: true, configurable: true },
		scrollTo: { value: vi.fn(), configurable: true },
	});
	return element as HTMLElement & {
		scrollHeight: number;
		scrollTop: number;
		scrollTo: ReturnType<typeof vi.fn>;
	};
}

function mount() {
	const { result } = renderHook(() => useTranscriptScroll('conversation-1'));
	const element = transcriptElement();
	result.current.transcript.current = element;
	act(() => result.current.align());
	element.scrollTo.mockClear();
	const scroll = () =>
		result.current.onScroll({ currentTarget: element } as unknown as UIEvent<HTMLElement>);
	return { result, element, scroll };
}

describe('useTranscriptScroll', () => {
	it('keeps following when only the content resized', () => {
		const { result, element, scroll } = mount();
		element.scrollHeight = 2400;
		scroll();
		act(() => result.current.align());
		expect(element.scrollTo).toHaveBeenCalledWith({ top: 2400 });
	});

	it('stops following when the reader scrolls up in the same frame as new content', () => {
		const { result, element, scroll } = mount();
		element.scrollHeight = 2400;
		element.scrollTop = 1200;
		scroll();
		act(() => result.current.align());
		expect(element.scrollTo).not.toHaveBeenCalled();
	});

	it('resumes following once the reader returns to the end', () => {
		const { result, element, scroll } = mount();
		element.scrollTop = 1200;
		scroll();
		element.scrollTop = 1580;
		scroll();
		act(() => result.current.align());
		expect(element.scrollTo).toHaveBeenCalledWith({ top: 2000 });
	});
});
