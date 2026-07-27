import { useState } from 'react';
import { useInterval } from '@/hooks/useInterval';

/**
 * A `Date.now()` that ticks, so a rendered elapsed/relative time stays live.
 * Pass `null` to freeze it — e.g. while the popover showing it is closed.
 */
export function useNow(intervalMs: number | null = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), intervalMs);
	return now;
}
