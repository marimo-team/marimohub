import { useCallback, useMemo, useState } from 'react';

export interface DialogTarget<T> {
	/** The row/record the dialog is acting on, or `null` while closed. */
	target: T | null;
	isOpen: boolean;
	open: (target: T) => void;
	close: () => void;
}

/**
 * {@link useDisclosure} for a dialog that acts on a *subject* — the notebook
 * being deleted, the member being removed. Openness is derived from the target
 * rather than tracked alongside it, so the two can never disagree.
 */
export function useDialogTarget<T>(initialTarget: T | null = null): DialogTarget<T> {
	const [target, setTarget] = useState<T | null>(initialTarget);
	const open = useCallback((next: T) => setTarget(next), []);
	const close = useCallback(() => setTarget(null), []);
	return useMemo(() => ({ target, isOpen: target !== null, open, close }), [target, open, close]);
}
