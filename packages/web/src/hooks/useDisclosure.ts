import { useCallback, useMemo, useState } from 'react';

export interface Disclosure {
	isOpen: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
	setOpen: (open: boolean) => void;
}

/**
 * Boolean open/close state for modals, popovers, drawers, etc. Replaces the
 * scattered `const [showX, setShowX] = useState(false)` + inline setters with one
 * memoized, reusable handle. Callbacks are stable, so passing them to children
 * never re-triggers memoized subtrees.
 */
export function useDisclosure(initialOpen = false): Disclosure {
	const [isOpen, setOpen] = useState(initialOpen);
	const open = useCallback(() => setOpen(true), []);
	const close = useCallback(() => setOpen(false), []);
	const toggle = useCallback(() => setOpen((v) => !v), []);
	return useMemo(() => ({ isOpen, open, close, toggle, setOpen }), [isOpen, open, close, toggle]);
}
