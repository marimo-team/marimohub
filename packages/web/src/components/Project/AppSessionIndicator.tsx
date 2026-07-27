import { useState } from 'react';
import { AppWindow, Power, RefreshCw } from 'lucide-react';
import type { Session } from '@/types';
import { useNotebookQuery, useUsersQuery } from '@/api/hooks';
import { Button, Popover, UserLabel } from '@/components/ui';
import { useInterval } from '@/hooks/useInterval';
import { cn } from '@/lib/utils';
import { formatDuration, formatRelative } from '@/lib/time';

// App-indicator treatment per status: an AppWindow glyph colored like the
// kernel dot, so the row reads "per-user edit dot + shared app glyph".
const APP_STATUS: Partial<
	Record<Session['status'], { className: string; label: string; pulse?: boolean }>
> = {
	running: { className: 'text-green-600 dark:text-green-500', label: 'App running' },
	starting: { className: 'text-amber-500', label: 'App starting', pulse: true },
	terminating: { className: 'text-orange-500', label: 'App stopping', pulse: true },
};

/** Tick `now` once a second so an open popover's elapsed duration stays live. */
function useNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), 1000);
	return now;
}

/**
 * Whether the app session is serving an older version than the notebook's
 * current head. NOTE: the periodic snapshotter commits a fresh version every
 * ~2 minutes while someone is editing, so callers must also suppress the hint
 * while an edit session is live on the notebook (`editActive`) — otherwise it
 * flaps for the whole editing session.
 */
export function isAppStale(
	session: Pick<Session, 'source_version_id'>,
	currentVersionId: string | null | undefined,
): boolean {
	return (
		!!session.source_version_id &&
		!!currentVersionId &&
		currentVersionId !== session.source_version_id
	);
}

function AppSessionDetails({
	session,
	label,
	canControl,
	canOpen,
	editActive,
	onStop,
	onRestart,
}: {
	session: Session;
	label: string;
	canControl: boolean;
	canOpen: boolean;
	editActive: boolean;
	onStop: () => void;
	onRestart: () => void;
}) {
	const now = useNow();
	const { data: users } = useUsersQuery([session.user_id]);
	// Lazy (popover-open only) head-version fetch for the stale hint. `staleTime:
	// 0` because this mounts only while the popover is open: the shared cache may
	// hold a head from before an edit session committed a new version, and nothing
	// invalidates it — a cached read would hide the stale hint entirely.
	const { data: notebook } = useNotebookQuery(session.project_id, session.notebook_id, {
		staleTime: 0,
	});
	// Suppressed while the notebook is being edited — the head is still moving.
	const stale = !editActive && isAppStale(session, notebook?.source.current_version_id);
	const connections = session.active_connections;

	return (
		<div className="flex min-w-[13rem] flex-col gap-2 text-xs">
			<div className="font-medium text-foreground">{label}</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
				<dt>Started by</dt>
				<dd className="min-w-0">
					<UserLabel
						user={users?.[session.user_id]}
						fallbackId={session.user_id}
						className="block max-w-[10rem] text-foreground"
					/>
				</dd>
				<dt>Started</dt>
				<dd className="text-foreground">{formatRelative(session.started_at, now)}</dd>
				{session.status === 'running' && (
					<>
						<dt>Up for</dt>
						<dd className="text-foreground tabular-nums">
							{formatDuration(session.started_at, now)}
						</dd>
					</>
				)}
				{typeof connections === 'number' && (
					<>
						<dt>Connected</dt>
						<dd className="text-foreground tabular-nums">~{connections}</dd>
					</>
				)}
			</dl>
			{stale && (
				<p className="text-amber-600 dark:text-amber-500">
					The notebook has changed since this app started. Restart to update.
				</p>
			)}
			{!canControl && (
				<p className="text-muted-foreground">
					{canOpen
						? 'Only editors can stop or restart this app.'
						: 'Apps are editor-only for now — ask an editor for access.'}
				</p>
			)}
			{canControl && (
				<div className="flex gap-1.5 pt-0.5">
					<Button variant="default" size="sm" onPress={onRestart}>
						<RefreshCw className="size-3.5" />
						Restart
					</Button>
					<Button
						variant="unstyled"
						className="flex items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
						onPress={onStop}
					>
						<Power className="size-3.5" />
						Stop
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * The shared-app indicator on a notebook row: an AppWindow glyph colored by the
 * app session's status, with a popover carrying attribution, an approximate
 * connection count, the stale hint, and (for editors) Stop/Restart. Renders
 * nothing once the session is terminal.
 */
export function AppSessionIndicator({
	session,
	canControl,
	canOpen = false,
	editActive = false,
	onStop,
	onRestart,
}: {
	session: Session;
	/** Editors may stop/restart the shared app; viewers only see its state. */
	canControl: boolean;
	/** The caller may open the app (viewers, when the viewer mode grants apps). */
	canOpen?: boolean;
	/** An edit session is live on the notebook — suppresses the stale hint. */
	editActive?: boolean;
	onStop: () => void;
	onRestart: () => void;
}) {
	const status = APP_STATUS[session.status];
	if (!status) return null;

	return (
		<Popover
			label={`${status.label} — details`}
			tooltip={status.label}
			trigger={
				<AppWindow className={cn('size-3.5', status.className, status.pulse && 'animate-pulse')} />
			}
			triggerClassName="cursor-pointer rounded"
		>
			<AppSessionDetails
				session={session}
				label={status.label}
				canControl={canControl}
				canOpen={canOpen}
				editActive={editActive}
				onStop={onStop}
				onRestart={onRestart}
			/>
		</Popover>
	);
}
