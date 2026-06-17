import { useEffect, useState } from 'react';

/**
 * The given value, updated only after it has stopped changing for `delayMs`.
 * Used to throttle per-keystroke work (e.g. the member-picker search query).
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
	const [debounced, setDebounced] = useState(value);

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);

	return debounced;
}
