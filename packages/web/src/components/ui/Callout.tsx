import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface CalloutProps {
	variant: 'warning' | 'error' | 'info';
	children: ReactNode;
	className?: string;
}

const variantClasses: Record<CalloutProps['variant'], string> = {
	warning: 'border-amber-500/30 bg-amber-500/5',
	error: 'border-destructive/30 bg-destructive/5',
	info: 'border-border bg-muted/30',
};

export function Callout({ variant, children, className }: CalloutProps) {
	return (
		<div
			role={variant === 'error' ? 'alert' : 'status'}
			className={cn('rounded-lg border p-3 text-sm', variantClasses[variant], className)}
		>
			{children}
		</div>
	);
}
