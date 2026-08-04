import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Small rounded-pill label, e.g. the "App"/"Snapshot" page badges. */
export function Chip({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<span
			className={cn(
				'flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary',
				className,
			)}
		>
			{children}
		</span>
	);
}
