import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SkeletonProps = HTMLAttributes<HTMLSpanElement>;

/** A pulsing placeholder for a value that is still loading. Size it via `className`. */
export function Skeleton({ className, ...props }: SkeletonProps) {
	return (
		<span
			className={cn('inline-block animate-pulse rounded bg-muted-foreground/20', className)}
			aria-hidden="true"
			{...props}
		/>
	);
}
