import type { ReactNode } from 'react';
import { MenuTrigger, Button, Popover, Menu, MenuItem, Separator } from 'react-aria-components';
import { ChevronDown } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { cn } from '@/lib/utils';

export interface DropdownMenuOption {
	/** Stable key passed back to `onAction`. */
	id: string;
	label: ReactNode;
	icon?: ReactNode;
	separatorBefore?: boolean;
	isDisabled?: boolean;
	/** Render the item in the destructive style (e.g. Delete). */
	danger?: boolean;
}

export interface DropdownMenuProps {
	/** Accessible label for the trigger button. */
	label: string;
	/** Trigger icon, e.g. `<MoreHorizontal className="size-4" />`. */
	icon?: ReactNode;
	triggerLabel?: ReactNode;
	header?: ReactNode;
	tooltip?: string;
	/** Override the trigger button styling. */
	triggerClassName?: string;
	isDisabled?: boolean;
	options: DropdownMenuOption[];
	onAction: (key: string) => void;
}

/**
 * A small menu built on react-aria-components, mirroring the popover/menu
 * styling used by the header user menu. The popover is portaled, so item clicks
 * never bubble to an enclosing row.
 */
export function DropdownMenu({
	label,
	icon,
	triggerLabel,
	header,
	tooltip,
	triggerClassName,
	isDisabled,
	options,
	onAction,
}: DropdownMenuProps) {
	const isLabeled = triggerLabel !== undefined;
	const button = (
		<Button
			aria-label={label}
			isDisabled={isDisabled}
			className={cn(
				'flex size-7 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
				isLabeled && 'h-8 w-auto min-w-0 shrink-0 gap-1 rounded-md px-2 text-xs max-md:min-h-11',
				triggerClassName,
			)}
		>
			{icon}
			{isLabeled && (
				<>
					<span className="truncate">{triggerLabel}</span>
					<ChevronDown className="size-3 shrink-0" />
				</>
			)}
		</Button>
	);
	return (
		<MenuTrigger>
			{tooltip ? (
				<Tooltip content={tooltip} className="break-words">
					{button}
				</Tooltip>
			) : (
				button
			)}
			<Popover
				placement="bottom end"
				className="z-50 min-w-[200px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95"
			>
				{header && <div className="border-b px-3 py-2 text-xs">{header}</div>}
				<Menu className="outline-none" onAction={(key) => onAction(String(key))}>
					{options.flatMap((opt) => [
						...(opt.separatorBefore
							? [<Separator key={`${opt.id}-separator`} className="h-px bg-border" />]
							: []),
						<MenuItem
							key={opt.id}
							id={opt.id}
							isDisabled={opt.isDisabled}
							className={cn(
								'flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors data-[disabled]:cursor-default data-[disabled]:opacity-50 max-md:min-h-11',
								opt.danger
									? 'text-destructive focus:bg-destructive/10'
									: 'text-popover-foreground focus:bg-muted',
							)}
						>
							{opt.icon}
							{opt.label}
						</MenuItem>,
					])}
				</Menu>
			</Popover>
		</MenuTrigger>
	);
}
