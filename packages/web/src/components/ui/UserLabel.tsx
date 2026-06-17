import type { ResolvedUser } from '@/types';
import { cn } from '@/lib/utils';
import { Skeleton } from './Skeleton';

export interface UserLabelProps {
	/** Resolved identity, when available from the user directory. */
	user?: ResolvedUser;
	/** Raw user id, rendered (truncated) until the identity resolves. */
	fallbackId: string;
	/** Directory lookup in flight: show a skeleton instead of the raw id. */
	loading?: boolean;
	className?: string;
}

/** Display name for a user, with the email as a hover title for disambiguation. */
function displayName(user: ResolvedUser | undefined, fallbackId: string): string {
	return user?.name || user?.email || fallbackId;
}

/**
 * Render a user's display name, resolving an opaque id (`author` / session
 * `user_id`) to a human name via the directory. The email is surfaced on hover.
 * Presentational: the caller supplies the already-resolved {@link ResolvedUser}.
 */
export function UserLabel({ user, fallbackId, loading, className }: UserLabelProps) {
	// Skeleton only until the identity first resolves, not on background refetches.
	if (loading && !user) {
		return <Skeleton className={cn('h-3 w-16 align-middle', className)} />;
	}

	return (
		<span className={cn('truncate', className)} title={user?.email ?? fallbackId}>
			{displayName(user, fallbackId)}
		</span>
	);
}
