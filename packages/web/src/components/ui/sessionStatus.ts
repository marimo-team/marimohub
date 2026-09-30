import type { Session } from '@/types';

export interface SessionStatusPresentation {
	label: string;
	className: string;
	pulse?: boolean;
}

const SESSION_STATUS: Partial<Record<string, SessionStatusPresentation>> = {
	running: { label: 'Running', className: 'bg-green-500' },
	starting: { label: 'Starting', className: 'bg-amber-500', pulse: true },
	terminating: { label: 'Stopping', className: 'bg-orange-500', pulse: true },
	failed: { label: 'Failed', className: 'bg-destructive' },
	terminated: { label: 'Stopped', className: 'bg-muted-foreground' },
	expired: { label: 'Expired', className: 'bg-muted-foreground' },
} satisfies Record<Session['status'], SessionStatusPresentation>;

const UNKNOWN: SessionStatusPresentation = { label: 'Unknown', className: 'bg-muted-foreground' };

// The server may send a status newer than this client.
export function isKnownSessionStatus(status: string): boolean {
	return Object.hasOwn(SESSION_STATUS, status);
}

export function sessionStatusPresentation(status: Session['status']): SessionStatusPresentation {
	return (isKnownSessionStatus(status) && SESSION_STATUS[status]) || UNKNOWN;
}
