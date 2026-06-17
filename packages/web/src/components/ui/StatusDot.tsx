import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
	/** Pulse animation (e.g. while a kernel is starting). */
	pulse?: boolean;
}

/**
 * A small colored status dot. Pure presentation: the caller sets the color (via
 * `className`) and any hover hint by wrapping it in a {@link Tooltip}. Shared by
 * the notebook table (`SessionStatusDot`) and the NotebookPage header so the
 * indicator looks identical everywhere. forwardRef so it can be a tooltip trigger.
 */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
	{ className, pulse, ...props },
	ref,
) {
	return (
		<span
			ref={ref}
			className={cn('size-2 shrink-0 rounded-full', pulse && 'animate-pulse', className)}
			{...props}
		/>
	);
});
