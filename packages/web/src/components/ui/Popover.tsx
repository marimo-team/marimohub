import type { ReactNode } from 'react';
import {
	DialogTrigger,
	Button as AriaButton,
	Popover as AriaPopover,
	Tooltip as AriaTooltip,
	TooltipTrigger,
	Dialog,
} from 'react-aria-components';
import type { Placement } from 'react-aria-components';
import { cn } from '@/lib/utils';

export interface PopoverProps {
	/** The clickable trigger content (wrapped in a focusable button). */
	trigger: ReactNode;
	/** Popover body. Only mounted while open, so timers inside it run only then. */
	children: ReactNode;
	/** Accessible label for the trigger button. */
	label?: string;
	/** Optional hover/focus tooltip on the trigger — a quick hint before pressing. */
	tooltip?: ReactNode;
	placement?: Placement;
	/** Extra classes for the trigger button (e.g. layout/reset). */
	triggerClassName?: string;
	/** Extra classes for the popover surface. */
	className?: string;
}

/**
 * A small press-to-open popover over {@link https://react-spectrum.adobe.com/react-aria
 * react-aria-components} (the same primitive the header menu uses), styled with
 * the shared Tailwind tokens to match {@link DialogModal}. Used for rich,
 * on-demand detail surfaced from a compact affordance — e.g. a notebook's
 * session attribution behind its status dot.
 */
export function Popover({
	trigger,
	children,
	label,
	tooltip,
	placement = 'bottom',
	triggerClassName,
	className,
}: PopoverProps) {
	const button = (
		<AriaButton
			aria-label={label}
			className={cn(
				'inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
				triggerClassName,
			)}
		>
			{trigger}
		</AriaButton>
	);
	return (
		<DialogTrigger>
			{tooltip ? (
				<TooltipTrigger delay={500} closeDelay={0}>
					{button}
					<AriaTooltip
						offset={6}
						className="z-50 max-w-xs rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95"
					>
						{tooltip}
					</AriaTooltip>
				</TooltipTrigger>
			) : (
				button
			)}
			<AriaPopover
				placement={placement}
				className={cn(
					'z-50 max-w-xs rounded-md border bg-popover text-popover-foreground shadow-lg',
					'entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95',
					className,
				)}
			>
				<Dialog className="p-3 outline-none">{children}</Dialog>
			</AriaPopover>
		</DialogTrigger>
	);
}
