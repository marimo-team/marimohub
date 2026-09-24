import type { Session } from '@/types';
import { useUsersQuery } from '@/api/hooks';
import { useNow } from '@/hooks/useNow';
import { formatDuration, formatRelative } from '@/lib/time';
import { UserLabel } from './UserLabel';
import { computeSessionPresentation } from '@/components/Notebook/computeProfiles';
import type { ComputeProfile } from '@/components/Notebook/computeProfiles';

export function SessionDetails({
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
	const showDuration = session.status === 'running';
	const selectedProfile =
		profiles.find((profile) => profile.name === selectedProfileName) ?? profiles[0];
	const compute = computeSessionPresentation(session, profiles, selectedProfile);

	return (
		<div className="flex min-w-[12rem] flex-col gap-2 text-xs">
			<div className="font-medium text-foreground">{label}</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
				{session.user_id && (
					<>
						<dt>Started by</dt>
						<dd className="min-w-0">
							<UserLabel
								user={users?.[session.user_id]}
								fallbackId={session.user_id}
								className="block max-w-[10rem] text-foreground"
							/>
						</dd>
					</>
				)}
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
			{[compute.pendingMessage, compute.snapshotMessage].map(
				(message) =>
					message && (
						<span
							key={message}
							className="w-fit rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400"
						>
							{message}
						</span>
					),
			)}
		</div>
	);
}
