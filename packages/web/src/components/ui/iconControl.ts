import { cn } from '@/lib/utils';

/**
 * Shared styling for icon-only controls so `IconButton` (a `<button>`) and
 * `IconLink` (an `<a>`) look identical, with a focus-visible ring and disabled
 * state baked in.
 */
export type IconControlSize = 'sm' | 'md';
export type IconControlTone = 'default' | 'danger';
export type IconControlVariant = 'plain' | 'bordered';

export const ICON_CONTROL_SIZE: Record<IconControlSize, string> = {
	sm: 'size-7',
	md: 'size-8',
};

const TONE: Record<IconControlTone, string> = {
	default: 'text-muted-foreground hover:bg-muted hover:text-foreground',
	danger: 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
};

const VARIANT: Record<IconControlVariant, string> = {
	plain: '',
	bordered: 'border border-input shadow-xs hover:border-ring',
};

export function iconControlClass(opts: {
	size?: IconControlSize;
	tone?: IconControlTone;
	variant?: IconControlVariant;
	className?: string;
}): string {
	const { size = 'sm', tone = 'default', variant = 'plain', className } = opts;
	return cn(
		'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors',
		'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
		'disabled:cursor-not-allowed disabled:opacity-50',
		ICON_CONTROL_SIZE[size],
		TONE[tone],
		VARIANT[variant],
		className,
	);
}
