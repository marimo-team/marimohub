import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface RowLinkProps {
	/** Destination URL (a real `<a href>`). */
	to: string;
	/** Router state passed on plain navigation (ignored by new-tab opens, which reload). */
	state?: unknown;
	/** Accessible name for the link when the visible content isn't self-describing. */
	label?: string;
	children: ReactNode;
	/** Trailing controls rendered OUTSIDE the anchor (valid HTML — no buttons in `<a>`). */
	actions?: ReactNode;
	/** Layout classes for the anchor's content (e.g. `flex-col gap-1` or `justify-between`). */
	contentClassName?: string;
	testId?: string;
}

/**
 * A list row whose primary surface is a real `<a href>` (react-router `Link`)
 * rather than a `div onClick={navigate()}`, so modified-click / middle-click /
 * "Open in new tab" and keyboard activation all work. `actions` render beside the
 * anchor, not inside it, keeping the markup valid.
 */
export function RowLink({
	to,
	state,
	label,
	children,
	actions,
	contentClassName,
	testId,
}: RowLinkProps) {
	return (
		<div
			data-testid={testId}
			className="group relative flex items-center border-b border-l-[3px] border-l-transparent transition-colors last:border-b-0 hover:border-l-primary hover:bg-muted/60"
		>
			<Link
				to={to}
				state={state}
				aria-label={label}
				className={cn(
					'flex min-w-0 flex-1 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
					contentClassName,
				)}
			>
				{children}
			</Link>
			{actions && <div className="relative flex shrink-0 items-center gap-1 pr-2">{actions}</div>}
		</div>
	);
}
