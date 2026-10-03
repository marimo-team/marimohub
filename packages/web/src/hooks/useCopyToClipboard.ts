import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';

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
			const copied = await copyText(value);
			setCopied(copied);
			clearTimeout(timer.current);
			if (copied) timer.current = setTimeout(() => setCopied(false), resetAfterMs);
			return copied;
		},
		[resetAfterMs],
	);

	return { copied, copy };
}
