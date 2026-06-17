import type { ReactNode } from 'react';

export interface EmptyStateProps {
	/** The primary message — e.g. "No notebooks yet". */
	message: ReactNode;
	/** Optional supporting line under the message. */
	description?: ReactNode;
	/** Optional icon rendered in a soft tile above the message. */
	icon?: ReactNode;
	/** Optional call-to-action, typically a Button. */
	action?: ReactNode;
}

/**
 * The dashed "nothing here" card used by every list view. Dumb: it renders the
 * icon/message and an optional action; the caller owns what they are.
 */
export function EmptyState({ message, description, icon, action }: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center gap-4 rounded-xl border border-dashed bg-card/50 px-8 py-14 text-center">
			{icon && (
				<div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
					{icon}
				</div>
			)}
			<div className="flex flex-col gap-1">
				<p className="text-sm font-medium text-foreground">{message}</p>
				{description && <p className="text-sm text-muted-foreground">{description}</p>}
			</div>
			{action}
		</div>
	);
}
