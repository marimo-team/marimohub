import type { ComponentProps, ReactNode } from 'react';
import { Focusable, Tooltip as AriaTooltip, TooltipTrigger } from 'react-aria-components';
import type { Placement } from 'react-aria-components';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/useMediaQuery';

export interface TooltipProps {
	/** Text shown on hover/focus of the trigger. */
	content: ReactNode;
	/** The trigger — a single focusable element (e.g. a button). */
	children: ComponentProps<typeof Focusable>['children'];
	placement?: Placement;
	/** Hover delay before showing, in ms. */
	delay?: number;
	className?: string;
}

/**
 * A hover/focus tooltip over react-aria-components, styled with the shared
 * Tailwind tokens to match {@link Popover}. Use it for icon-only controls in
 * place of the native `title` attribute. The child still needs its own
 * accessible name (e.g. `aria-label`); the tooltip is the description.
 */
export function Tooltip({
	content,
	children,
	placement = 'top',
	delay = 500,
	className,
}: TooltipProps) {
	// On touch devices there is no hover, and a long-press can pin a stray
	// tooltip over the tap target. Render just the trigger — its own accessible
	// name (e.g. `aria-label`) keeps the control labelled.
	const isMobile = useIsMobile();
	if (isMobile) {
		return children;
	}

	return (
		<TooltipTrigger delay={delay} closeDelay={0}>
			<Focusable>{children}</Focusable>
			<AriaTooltip
				placement={placement}
				offset={6}
				className={cn(
					'z-50 max-w-xs rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
					'entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95',
					className,
				)}
			>
				{content}
			</AriaTooltip>
		</TooltipTrigger>
	);
}
