import { useEffect, useRef } from 'react';

/**
 * Run `callback` every `delayMs`; pass `delayMs = null` to pause. Always invokes
 * the latest `callback` without resetting the timer (the ref pattern), so a
 * changing closure doesn't restart the cadence.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
	const saved = useRef(callback);
	useEffect(() => {
		saved.current = callback;
	}, [callback]);

	useEffect(() => {
		if (delayMs === null) return;
		const id = setInterval(() => saved.current(), delayMs);
		return () => clearInterval(id);
	}, [delayMs]);
}
