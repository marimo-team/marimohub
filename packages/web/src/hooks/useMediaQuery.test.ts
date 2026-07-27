import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { installMatchMedia } from '@/test/render';
import { useIsMobile, useMediaQuery } from './useMediaQuery';

interface MediaStub {
	/** Flip a query and notify its subscribers, as the browser would. */
	fire: (query: string, matches: boolean) => void;
	listenerCount: (query: string) => number;
	queries: () => string[];
}

/**
 * `installMatchMedia` from the test helpers has no-op listeners, so it can't
 * model a query that changes after mount. This one keeps a listener set per
 * query — shared across the `MediaQueryList` objects the hook creates on each
 * effect run — so `fire` reaches whatever is currently subscribed.
 */
function installLiveMatchMedia(matchesFor: (query: string) => boolean): MediaStub {
	const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
	const listFor = (query: string) => {
		let entry = lists.get(query);
		if (!entry) {
			entry = { matches: matchesFor(query), listeners: new Set() };
			lists.set(query, entry);
		}
		return entry;
	};

	vi.stubGlobal('matchMedia', (query: string) => {
		const entry = listFor(query);
		return {
			get matches() {
				return entry.matches;
			},
			media: query,
			onchange: null,
			addEventListener: (_type: string, listener: () => void) => entry.listeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) =>
				entry.listeners.delete(listener),
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		};
	});

	return {
		fire(query, matches) {
			const entry = listFor(query);
			entry.matches = matches;
			act(() => {
				for (const listener of entry.listeners) listener();
			});
		},
		listenerCount: (query) => listFor(query).listeners.size,
		queries: () => [...lists.keys()],
	};
}

describe('useMediaQuery', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reports the initial match state', () => {
		installMatchMedia(true);
		const matching = renderHook(() => useMediaQuery('(min-width: 900px)'));
		expect(matching.result.current).toBe(true);

		installMatchMedia(false);
		const notMatching = renderHook(() => useMediaQuery('(min-width: 900px)'));
		expect(notMatching.result.current).toBe(false);
	});

	it('re-renders when the media list fires a change', () => {
		const media = installLiveMatchMedia(() => false);
		const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
		expect(result.current).toBe(false);

		media.fire('(max-width: 767px)', true);
		expect(result.current).toBe(true);

		media.fire('(max-width: 767px)', false);
		expect(result.current).toBe(false);
	});

	it('removes its listener on unmount', () => {
		const media = installLiveMatchMedia(() => false);
		const { unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'));
		expect(media.listenerCount('(max-width: 767px)')).toBe(1);

		unmount();
		expect(media.listenerCount('(max-width: 767px)')).toBe(0);

		media.fire('(max-width: 767px)', true); // no subscriber left to update
	});

	it('re-subscribes when the query changes', () => {
		const media = installLiveMatchMedia((query) => query === '(min-width: 900px)');
		const { result, rerender } = renderHook(({ query }) => useMediaQuery(query), {
			initialProps: { query: '(max-width: 767px)' },
		});
		expect(result.current).toBe(false);

		rerender({ query: '(min-width: 900px)' });
		expect(result.current).toBe(true);
		expect(media.listenerCount('(max-width: 767px)')).toBe(0);
		expect(media.listenerCount('(min-width: 900px)')).toBe(1);

		// Changes on the abandoned query no longer matter.
		media.fire('(max-width: 767px)', true);
		expect(result.current).toBe(true);

		media.fire('(min-width: 900px)', false);
		expect(result.current).toBe(false);
	});
});

describe('useIsMobile', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('queries the 767px breakpoint exactly', () => {
		const media = installLiveMatchMedia(() => false);
		renderHook(() => useIsMobile());
		expect(media.queries()).toEqual(['(max-width: 767px)']);
	});

	it('tracks the phone-width breakpoint', () => {
		const media = installLiveMatchMedia((query) => query === '(max-width: 767px)');
		const { result } = renderHook(() => useIsMobile());
		expect(result.current).toBe(true);

		media.fire('(max-width: 767px)', false);
		expect(result.current).toBe(false);
	});
});
