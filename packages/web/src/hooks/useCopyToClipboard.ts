import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export interface Clipboard {
	/** True for `resetAfterMs` following a successful copy — drives the ✓ swap. */
	copied: boolean;
	/** Resolves to whether the write landed, for callers wanting their own toast. */
	copy: (value: string) => Promise<boolean>;
}

/**
 * The reset timer is cleared on unmount, so copying from a dialog and closing it
 * within the window does not set state on a gone component. A rejected
 * `writeText` (no permission, insecure context) toasts rather than going
 * unhandled.
 */
export function useCopyToClipboard(resetAfterMs = 1500): Clipboard {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const copy = useCallback(
		async (value: string) => {
			try {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), resetAfterMs);
				return true;
			} catch {
				// Clear the flag rather than leaving it: a failed copy that follows a
				// successful one inside the reset window would otherwise keep showing ✓.
				clearTimeout(timer.current);
				setCopied(false);
				toast.error('Could not copy to clipboard');
				return false;
			}
		},
		[resetAfterMs],
	);

	return { copied, copy };
}
