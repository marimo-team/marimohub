import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
	pulse?: boolean;
}

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
