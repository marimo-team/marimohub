import type { Session } from '@/types';
import { useUsersQuery } from '@/api/hooks';
import { useNow } from '@/hooks/useNow';
import { formatDuration, formatRelative } from '@/lib/time';
import { StatusDot } from './StatusDot';
import { Popover } from './Popover';
import { Skeleton } from './Skeleton';
import { UserLabel } from './UserLabel';
import { computeSessionPresentation } from '@/components/Notebook/computeProfiles';
import type { ComputeProfile } from '@/components/Notebook/computeProfiles';

interface SessionStatusDotProps {
	/** The notebook's most-alive session, or undefined when stopped. */
	session: Session | undefined;
	/** Sessions still loading: show a placeholder dot rather than nothing. */
	loading?: boolean;
	profiles?: ComputeProfile[];
	selectedProfileName?: string;
}

// Maps a runtime status to the dot's color + label. Stopped notebooks (no active
// session, or a terminal `terminated`/`expired` one) render nothing.
const STATUS_DOT: Partial<
	Record<NonNullable<Session['status']>, { className: string; label: string; pulse?: boolean }>
> = {
	running: { className: 'bg-green-500', label: 'Running' },
	starting: { className: 'bg-amber-500', label: 'Starting', pulse: true },
	terminating: { className: 'bg-orange-500', label: 'Stopping', pulse: true },
	failed: { className: 'bg-red-500', label: 'Failed' },
};

/**
 * Popover body for a live session: who started it, when, and (while running) how
 * long it has been up. Mounted only while the popover is open, so its 1s ticker
 * runs only then.
 */
function SessionDetails({
	session,
	label,
	profiles,
	selectedProfileName,
}: {
	session: Session;
	label: string;
	profiles: ComputeProfile[];
	selectedProfileName?: string;
}) {
	const now = useNow();
	const { data: users } = useUsersQuery([session.user_id]);
	const user = users?.[session.user_id];
	const showDuration = session.status === 'running';
	const selectedProfile =
		profiles.find((profile) => profile.name === selectedProfileName) ?? profiles[0];
	const compute = computeSessionPresentation(session, profiles, selectedProfile);

	return (
		<div className="flex min-w-[12rem] flex-col gap-2 text-xs">
			<div className="font-medium text-foreground">{label}</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
				<dt>Started by</dt>
				<dd className="min-w-0">
					<UserLabel
						user={user}
						fallbackId={session.user_id}
						className="block max-w-[10rem] text-foreground"
					/>
				</dd>
				<dt>Started</dt>
				<dd className="text-foreground">{formatRelative(session.started_at, now)}</dd>
				{compute.runningLabel && (
					<>
						<dt>{compute.pending ? 'Running' : 'Compute'}</dt>
						<dd className="text-foreground">{compute.runningLabel}</dd>
					</>
				)}
				{compute.pending && compute.selectedLabel && (
					<>
						<dt>Next</dt>
						<dd className="text-foreground">{compute.selectedLabel}</dd>
					</>
				)}
				{showDuration && (
					<>
						<dt>Running for</dt>
						<dd className="text-foreground tabular-nums">
							{formatDuration(session.started_at, now)}
						</dd>
					</>
				)}
			</dl>
			{compute.pendingMessage && (
				<span className="w-fit rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
					{compute.pendingMessage}
				</span>
			)}
			{compute.snapshotMessage && (
				<span className="w-fit rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
					{compute.snapshotMessage}
				</span>
			)}
		</div>
	);
}

/**
 * A small colored dot reflecting a notebook's live runtime status. Clicking it
 * opens a popover with the session's attribution (who started it, when, and how
 * long it's been running). Renders nothing for stopped notebooks.
 */
export function SessionStatusDot({
	session,
	loading,
	profiles = [],
	selectedProfileName,
}: SessionStatusDotProps) {
	const dot = session ? STATUS_DOT[session.status] : undefined;
	// Before the first poll we can't tell stopped from running; hold a placeholder.
	if (loading && !session) return <Skeleton className="size-2 rounded-full" />;
	if (!session || !dot) return null;

	return (
		<Popover
			label={`Session ${dot.label} — details`}
			tooltip={dot.label}
			trigger={<StatusDot className={dot.className} pulse={dot.pulse} />}
			triggerClassName="cursor-pointer rounded-full"
		>
			<SessionDetails
				session={session}
				label={dot.label}
				profiles={profiles}
				selectedProfileName={selectedProfileName}
			/>
		</Popover>
	);
}
