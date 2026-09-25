import type { Session } from '@/types';

interface SessionStatusPresentation {
	label: string;
	className: string;
	pulse?: boolean;
}

export const SESSION_STATUS: Record<Session['status'], SessionStatusPresentation> = {
	running: { label: 'Running', className: 'bg-green-500' },
	starting: { label: 'Starting', className: 'bg-amber-500', pulse: true },
	terminating: { label: 'Stopping', className: 'bg-orange-500', pulse: true },
	failed: { label: 'Failed', className: 'bg-destructive' },
	terminated: { label: 'Stopped', className: 'bg-muted-foreground' },
	expired: { label: 'Expired', className: 'bg-muted-foreground' },
};
