import type { ReactNode } from 'react';
import { MenuTrigger, Button, Popover, Menu, MenuItem, Separator } from 'react-aria-components';
import { cn } from '@/lib/utils';

export interface DropdownMenuOption {
	/** Stable key passed back to `onAction`. */
	id: string;
	label: ReactNode;
	icon?: ReactNode;
	separatorBefore?: boolean;
	/** Render the item in the destructive style (e.g. Delete). */
	danger?: boolean;
}

export interface DropdownMenuProps {
	/** Accessible label for the trigger button (it is icon-only). */
	label: string;
	/** Trigger icon, e.g. `<MoreHorizontal className="size-4" />`. */
	icon: ReactNode;
	/** Override the trigger button styling. */
	triggerClassName?: string;
	options: DropdownMenuOption[];
	onAction: (key: string) => void;
}

/**
 * A small overflow ("…") menu built on react-aria-components, mirroring the
 * popover/menu styling used by the header user menu. The trigger is icon-only;
 * the popover is portaled, so item clicks never bubble to an enclosing row.
 */
export function DropdownMenu({
	label,
	icon,
	triggerClassName,
	options,
	onAction,
}: DropdownMenuProps) {
	return (
		<MenuTrigger>
			<Button
				aria-label={label}
				className={cn(
					'flex size-7 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
					triggerClassName,
				)}
			>
				{icon}
			</Button>
			<Popover
				placement="bottom end"
				className="z-50 min-w-[200px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95"
			>
				<Menu className="outline-none" onAction={(key) => onAction(String(key))}>
					{options.flatMap((opt) => [
						...(opt.separatorBefore
							? [<Separator key={`${opt.id}-separator`} className="h-px bg-border" />]
							: []),
						<MenuItem
							key={opt.id}
							id={opt.id}
							className={cn(
								'flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] outline-none transition-colors max-md:min-h-11',
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
