import type { ReactNode } from 'react';

export interface EmptyStateProps {
	/** The primary message — e.g. "No notebooks yet". */
	message: ReactNode;
	/** Optional call-to-action, typically a Button. */
	action?: ReactNode;
}

/**
 * The dashed "nothing here" card used by every list view. Dumb: it renders the
 * message and an optional action; the caller owns what they are.
 */
export function EmptyState({ message, action }: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed bg-card p-12 text-center text-muted-foreground">
			<p>{message}</p>
			{action}
		</div>
	);
}
