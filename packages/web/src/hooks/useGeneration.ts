import { useCallback, useMemo, useRef } from 'react';

export interface Generation {
	/** Invalidate everything in flight and return the new current generation. */
	bump: () => number;
	/** The generation to capture before starting async work. */
	current: () => number;
	/** False once a newer generation has started — drop the result. */
	isCurrent: (generation: number) => boolean;
}

/**
 * A monotonic counter for cancelling stale async work. `apiFetch` has no abort
 * hook and clearing a timer does not recall a request already in flight, so a
 * poll issued before a restart still lands after it. Capture `current()` before
 * the request and check `isCurrent()` before writing state; `bump()` on every
 * user-initiated transition orphans whatever was outstanding.
 *
 * A counter rather than comparing ids, so it also holds for work started while
 * the tracked id was still the old one.
 */
export function useGeneration(): Generation {
	const ref = useRef(0);
	const bump = useCallback(() => {
		ref.current += 1;
		return ref.current;
	}, []);
	const current = useCallback(() => ref.current, []);
	const isCurrent = useCallback((generation: number) => ref.current === generation, []);
	return useMemo(() => ({ bump, current, isCurrent }), [bump, current, isCurrent]);
}
