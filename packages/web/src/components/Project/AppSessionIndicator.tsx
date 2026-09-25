import { AppWindow, Power, RefreshCw } from 'lucide-react';
import type { Session } from '@/types';
import { useNotebookQuery } from '@/api/hooks';
import { Button, Popover } from '@/components/ui';
import { SessionDetails } from '@/components/ui/SessionDetails';
import { cn } from '@/lib/utils';
import { isSessionStale } from '@/lib/sessions';
import { effectiveComputeProfile } from '@/components/Notebook/computeProfiles';
import type { ComputeProfile } from '@/components/Notebook/computeProfiles';

const EMPTY_PROFILES: ComputeProfile[] = [];

// Use a distinct glyph so a shared app is not confused with the editor sandbox.
const APP_STATUS: Partial<
	Record<Session['status'], { className: string; label: string; pulse?: boolean }>
> = {
	running: { className: 'text-green-600 dark:text-green-500', label: 'App running' },
	starting: { className: 'text-amber-500', label: 'App starting', pulse: true },
	terminating: { className: 'text-orange-500', label: 'App stopping', pulse: true },
};

function AppSessionDetails({
	session,
	label,
	canControl,
	editActive,
	onStop,
	onRestart,
	profiles,
	allowComputeOverride,
	selectedProfileName,
}: {
	session: Session;
	label: string;
	canControl: boolean;
	editActive: boolean;
	onStop: () => void;
	onRestart: () => void;
	profiles: ComputeProfile[];
	allowComputeOverride: boolean;
	selectedProfileName?: string;
}) {
	// Lazy (popover-open only) head-version fetch for the stale hint. `staleTime:
	// 0` because this mounts only while the popover is open: the shared cache may
	// hold a head from before an edit session committed a new version, and nothing
	// invalidates it — a cached read would hide the stale hint entirely.
	const { data: notebook } = useNotebookQuery(session.project_id, session.notebook_id, {
		staleTime: 0,
	});
	// Suppressed while a LOCAL notebook is being edited — the snapshotter keeps
	// moving its head. A synced head moves only when a push lands, so an open
	// editor is no reason to hide the hint there.
	const suppressForLocalEdit = editActive && notebook?.source.type !== 'git';
	const stale =
		!suppressForLocalEdit && isSessionStale(session, notebook?.source.current_version_id);
	const connections = session.active_connections;
	const storedProfileName = notebook ? notebook.meta.compute_profile : selectedProfileName;
	const selectedProfile = effectiveComputeProfile(
		profiles,
		storedProfileName,
		allowComputeOverride,
	);

	return (
		<SessionDetails
			session={session}
			label={label}
			profiles={profiles}
			selectedProfileName={selectedProfile?.name}
			durationLabel="Up for"
			detailRows={
				<>
					{session.app_pool && (
						<>
							<dt>Pool state</dt>
							<dd className="text-foreground">{session.app_pool.state}</dd>
							<dt>Users</dt>
							<dd className="text-foreground">
								{session.app_pool.users}
								{session.app_pool.max_users === null ? '' : ` / ${session.app_pool.max_users}`}
							</dd>
						</>
					)}
					{session.source_version_id && (
						<>
							<dt>Version</dt>
							<dd className="max-w-48 truncate text-foreground" title={session.source_version_id}>
								{session.source_version_id}
							</dd>
						</>
					)}
					<dt>Sandbox session</dt>
					<dd className="max-w-48 truncate text-foreground" title={session.session_id}>
						{session.session_id}
					</dd>
					{typeof connections === 'number' && (
						<>
							<dt>Connected</dt>
							<dd className="text-foreground tabular-nums">~{connections}</dd>
						</>
					)}
				</>
			}
		>
			{stale && (
				<p className="text-amber-600 dark:text-amber-500">
					This sandbox serves an older version. New users receive the latest version.
				</p>
			)}
			{!canControl && (
				<p className="text-muted-foreground">Only editors can stop or restart this app.</p>
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
		</SessionDetails>
	);
}

export function AppSessionIndicator({
	session,
	canControl,
	editActive = false,
	onStop,
	onRestart,
	profiles = EMPTY_PROFILES,
	allowComputeOverride = false,
	selectedProfileName,
}: {
	session: Session;
	/** Editors may stop/restart the shared app; viewers only see its state. */
	canControl: boolean;
	/** An edit session is live on the notebook — suppresses the stale hint (local sources only). */
	editActive?: boolean;
	onStop: () => void;
	onRestart: () => void;
	profiles?: ComputeProfile[];
	allowComputeOverride?: boolean;
	selectedProfileName?: string;
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
			{({ close }) => (
				<AppSessionDetails
					session={session}
					label={status.label}
					canControl={canControl}
					editActive={editActive}
					onStop={() => {
						close();
						onStop();
					}}
					onRestart={() => {
						close();
						onRestart();
					}}
					profiles={profiles}
					allowComputeOverride={allowComputeOverride}
					selectedProfileName={selectedProfileName}
				/>
			)}
		</Popover>
	);
}
