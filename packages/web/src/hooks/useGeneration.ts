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
 * Guards state updates from async work that outlives a session transition.
 * The counter distinguishes generations even when the session id is unchanged.
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
