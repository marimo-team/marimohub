import { SESSION_STATUS } from './sessionStatus';
import { SessionDetails } from './SessionDetails';
import type { Session } from '@/types';
import { StatusDot } from './StatusDot';
import { Popover } from './Popover';
import { Skeleton } from './Skeleton';
import type { ComputeProfile } from '@/components/Notebook/computeProfiles';

const EMPTY_PROFILES: ComputeProfile[] = [];

interface SessionStatusDotProps {
	/** The notebook's most-alive session, or undefined when stopped. */
	session: Session | undefined;
	/** Sessions still loading: show a placeholder dot rather than nothing. */
	loading?: boolean;
	profiles?: ComputeProfile[];
	selectedProfileName?: string;
}

export function SessionStatusDot({
	session,
	loading,
	profiles = EMPTY_PROFILES,
	selectedProfileName,
}: SessionStatusDotProps) {
	// Before the first poll we can't tell stopped from running; hold a placeholder.
	if (loading && !session) return <Skeleton className="size-2 rounded-full" />;
	if (!session || session.status === 'terminated' || session.status === 'expired') return null;
	const dot = SESSION_STATUS[session.status];
	if (!dot) return null;

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
