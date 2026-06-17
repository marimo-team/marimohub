import { Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BrandProps {
	/** Larger mark + wordmark, for standalone screens like sign-in. */
	size?: 'sm' | 'lg';
	/** Hide the wordmark (the mark alone), e.g. on narrow viewports. */
	wordmarkClassName?: string;
	className?: string;
}

/**
 * The marimohub identity: a teal gradient tile around the circle mark, plus the
 * mono wordmark. Shared by the header and the sign-in screen so the brand renders
 * identically everywhere.
 */
export function Brand({ size = 'sm', wordmarkClassName, className }: BrandProps) {
	return (
		<span className={cn('flex items-center', size === 'sm' ? 'gap-2.5' : 'gap-3', className)}>
			<span
				className={cn(
					'flex items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-sm ring-1 ring-black/5 dark:from-teal-400 dark:to-teal-600 dark:ring-white/10',
					size === 'sm' ? 'size-7' : 'size-10 rounded-xl',
				)}
			>
				<Circle className={size === 'sm' ? 'size-4' : 'size-5'} strokeWidth={2.5} />
			</span>
			<span
				className={cn(
					'font-mono font-semibold tracking-[0.16em] text-foreground',
					size === 'sm' ? 'text-[13px]' : 'text-base',
					wordmarkClassName,
				)}
			>
				MARIMOHUB
			</span>
		</span>
	);
}
