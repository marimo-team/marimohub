import { useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
	AlertTriangle,
	AppWindow,
	ArrowLeft,
	Eye,
	GitBranch,
	Pencil,
	RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
	Button,
	ConfirmDialog,
	IconButton,
	IconLink,
	StatusDot,
	SessionStatusDot,
	Tooltip,
	UserLabel,
} from '@/components/ui';
import {
	useCapabilitiesQuery,
	useNotebookQuery,
	useProjectQuery,
	useProjectSessionsQuery,
	useEditorSessionQuery,
	useTakeoverEditorSession,
	useUserQuery,
	useUsersQuery,
} from '@/api/hooks';
import { useNotebookSession } from '@/hooks/useNotebookSession';
import type { SessionEnded } from '@/hooks/useNotebookSession';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useDisclosure } from '@/hooks/useDisclosure';
import { GitSourcePopover } from '@/components/Notebook/GitSourcePopover';
import { RenameNotebookDialog } from '@/components/Notebook/RenameNotebookDialog';
import { effectiveComputeProfile } from '@/components/Notebook/computeProfiles';
import { ComputeProfileIndicator } from '@/components/Notebook/ComputeProfileIndicator';
import { StaticNotebookView } from '@/components/NotebookPage/StaticNotebookView';
import { sessionConnectionHint, isSessionStale, sessionsByNotebook } from '@/lib/sessions';
import { useTheme } from '@/context/ThemeContext';
import type { Theme } from '@/context/ThemeContext';

/** Copy for the app page's terminal panel, keyed by how the session ended. */
function endedPanel(ended: SessionEnded): { title: string; message: string; canRestart: boolean } {
	// Access lost, not a stopped app: it is still serving everyone else, so
	// offering "Restart app" would only produce a 403.
	if (ended === 'access_lost') {
		return {
			title: 'Access ended',
			message: 'You no longer have access to this app.',
			canRestart: false,
		};
	}
	const stopped = (message: string) => ({ title: 'App stopped', message, canRestart: true });
	if (ended === 'terminated' || ended === 'terminating') return stopped('The app was stopped.');
	if (ended === 'expired') {
		return stopped('The app reached its session lifetime and was shut down.');
	}
	if (ended === 'failed') return stopped('The app crashed.');
	return stopped('The app is no longer running.');
}

function editorEndedPanel(ended: SessionEnded, endedBy?: string) {
	if (ended === 'takeover') {
		return {
			title: 'Editing was taken over',
			message: `${endedBy ?? 'Another editor'} took over editing; your work was saved and this sandbox was closed.`,
			canRestart: false,
		};
	}
	return {
		title: 'Editing session ended',
		message: 'This sandbox is no longer running.',
		canRestart: true,
	};
}

function activityWarning(name: string, state: 'active' | 'idle' | 'unknown' | 'starting'): string {
	if (state === 'active') return `${name} has an active connection.`;
	if (state === 'idle') return `${name} had no connections at the latest check.`;
	if (state === 'starting') return `${name}'s sandbox is still starting.`;
	return `${name}'s connection could not be checked. They may still be active.`;
}

/**
 * Point the embedded marimo app at the marimohub theme via its `?theme=` query
 * param (marimo-team/marimo#10196). The origin base lets a relative proxy URL
 * resolve; `theme` is already `'light' | 'dark'`.
 */
function withThemeParam(url: string, theme: Theme): string {
	try {
		const parsed = new URL(url, window.location.origin);
		parsed.searchParams.set('theme', theme);
		return parsed.toString();
	} catch {
		return url;
	}
}

export function NotebookPage({ variant = 'edit' }: { variant?: 'edit' | 'app' }) {
	const { pid, nid } = useParams<{ pid: string; nid: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const isApp = variant === 'app';

	const notebookTitle = (location.state as { title?: string } | null)?.title ?? nid ?? 'Notebook';
	const renameModal = useDisclosure();
	// Stop/Restart disconnect everyone using the shared app, so both confirm first.
	const confirmAppAction = useDialogTarget<'stop' | 'restart'>();
	// Restarting a git-synced editor discards its sandbox scratch state, so confirm.
	const confirmEditRestart = useDisclosure();
	const confirmEditStop = useDisclosure();
	const confirmTakeover = useDisclosure();
	const [editIntent, setEditIntent] = useState<'temporary' | undefined>();

	// The viewer branch (server-enforced regardless): editors get a session as
	// always; a viewer gets an edit kernel only when the deployment's evaluated
	// admission row (`capabilities.viewer_session_modes`) grants `edit`, and the
	// static snapshot view otherwise. The session auto-start is held until the
	// branch is decided so a viewer never fires a doomed request; a failed
	// capabilities probe (or version skew with an older API) falls back to the
	// grant-nothing row — the server default — never an infinite spinner. The
	// app page skips the branch entirely — the server admits viewers per its
	// row, and a disallowed viewer's create lands on the error panel (403, no
	// retry loop).
	const { data: project } = useProjectQuery(pid!);
	const { data: capabilities, isError: capabilitiesError } = useCapabilitiesQuery();
	const isViewer = project.your_role === 'viewer';
	const viewerGrants = capabilities
		? (capabilities.viewer_session_modes ?? [])
		: capabilitiesError
			? []
			: undefined;
	const viewerHasEditKernel = !!viewerGrants?.includes('edit');
	const staticView = !isApp && isViewer && viewerGrants !== undefined && !viewerHasEditKernel;
	const resolvingMode = !isApp && isViewer && viewerGrants === undefined;
	const { data: me, isFetched: userResolved } = useUserQuery();
	const capabilitiesResolved = capabilities !== undefined || capabilitiesError;
	const configuredEditorSharing = capabilities?.editor_sandbox_sharing ?? 'shared';
	const needsEditorState =
		!isApp && !isViewer && capabilitiesResolved && configuredEditorSharing === 'exclusive';
	const editorStateQuery = useEditorSessionQuery(pid!, nid!, needsEditorState);
	const editorState = editorStateQuery.data;
	const otherOwner =
		needsEditorState &&
		userResolved &&
		editorState?.holder?.user_id !== undefined &&
		editorState.holder.user_id !== me?.id;
	const showEditorChoice = !!otherOwner && editIntent !== 'temporary';
	const editorDecisionReady =
		isApp ||
		isViewer ||
		(capabilitiesResolved &&
			(!needsEditorState ||
				(editorStateQuery.isSuccess && (!editorState?.holder || userResolved))));
	const editorStateFailed = needsEditorState && editorStateQuery.isError;
	const takeover = useTakeoverEditorSession(pid!, nid!);

	const {
		session,
		error,
		isProvisioning,
		isRunning,
		sandboxUrl,
		ended,
		endedByUserId,
		start,
		startPersistent,
		startWithDefault,
		defaultRetryAttempted,
		stop,
		restart,
	} = useNotebookSession(pid!, nid!, {
		enabled:
			(isApp || !isViewer || viewerHasEditKernel) &&
			editorDecisionReady &&
			(!showEditorChoice || editIntent === 'temporary'),
		mode: isApp ? 'app' : 'edit',
		editIntent,
	});

	// Freeze the theme when the URL is first established, not on every toggle:
	// marimo reads `?theme=` only on load, so re-deriving it live would reload
	// (and reset) the running app. Restart mints a fresh URL and re-reads it.
	const { theme } = useTheme();
	const iframeSrc = useMemo(
		() => (sandboxUrl ? withThemeParam(sandboxUrl, theme) : undefined),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[sandboxUrl],
	);

	// Metadata for the "created by" line — loaded lazily so it never blocks the
	// kernel from starting. The author id is resolved to a name via the directory.
	// It also carries the head version for the staleness banners, which must track
	// versions committed server-side (snapshotter, teardown, git push) — hence the
	// poll; a cached-once head would never fire (or mis-fire) a banner. Edit pages
	// poll only git-synced sources — the one head that can move mid-edit.
	const { data: notebook } = useNotebookQuery(pid!, nid!, {
		refetchIntervalMs: isApp ? 30_000 : (n) => (n?.source.type === 'git' ? 30_000 : undefined),
	});
	const author = notebook?.meta.author;
	// Prefer the canonical title once detail loads, so a rename reflects immediately.
	const title = notebook?.meta.title ?? notebookTitle;
	const holderId = editorState?.holder?.user_id;
	const sharedStarterId =
		session?.editor_sandbox_sharing === 'shared' && !session.ephemeral
			? session.user_id
			: undefined;
	const { data: users } = useUsersQuery([
		author,
		holderId,
		sharedStarterId,
		endedByUserId ?? undefined,
	]);
	const holderName = holderId
		? (users?.[holderId]?.name ?? users?.[holderId]?.email ?? holderId)
		: '';
	const sharedStarterName = sharedStarterId
		? (users?.[sharedStarterId]?.name ?? users?.[sharedStarterId]?.email ?? sharedStarterId)
		: '';
	const endedByName = endedByUserId
		? (users?.[endedByUserId]?.name ?? users?.[endedByUserId]?.email ?? endedByUserId)
		: undefined;

	// App pages watch the project's sessions (5s poll) to know whether the
	// notebook is being edited: the periodic snapshotter commits a version every
	// ~2 minutes mid-edit, so the staleness banner is suppressed until editing
	// stops — otherwise it would flap (with a disconnect-everyone CTA) the whole
	// time someone types.
	// Stops once the app has ended — the banner it feeds is gone with the iframe.
	const { data: projectSessions } = useProjectSessionsQuery(pid!, isApp && !ended);
	const sessionByNotebook = useMemo(() => sessionsByNotebook(projectSessions), [projectSessions]);
	const editActive = isApp && !!sessionByNotebook.get(nid!)?.persistentEdit;
	// Suppressed while a LOCAL notebook is being edited — the snapshotter keeps
	// moving its head. A synced head moves only when a push lands, so an open
	// editor is no reason to hide the banner there.
	const suppressForLocalEdit = editActive && notebook?.source.type !== 'git';
	const appStale =
		isApp &&
		!!session &&
		!suppressForLocalEdit &&
		isSessionStale(session, notebook?.source.current_version_id);
	// No `editActive` suppression here: a synced head moves only when a push
	// lands, never from typing in the editor.
	const editStale =
		!isApp &&
		!!session &&
		notebook?.source.type === 'git' &&
		isSessionStale(session, notebook.source.current_version_id);
	// A viewer deep-linking to /app gets a plain 403 panel; retrying can only
	// fail again, so the button is dropped (no retry loop, manual or otherwise).
	const showRetry = error?.code !== 'FORBIDDEN';
	const terminal =
		ended && !isProvisioning
			? isApp
				? endedPanel(ended)
				: editorEndedPanel(ended, endedByName)
			: null;
	const computeProfiles = capabilities?.compute_profiles ?? [];
	const computeOverrideApplies =
		capabilities?.compute_profile_override === 'editors' && (!isViewer || isApp);
	const selectedComputeProfile = effectiveComputeProfile(
		computeProfiles,
		notebook?.meta.compute_profile,
		computeOverrideApplies,
	);
	const canRetryWithDefault =
		!isApp &&
		!!selectedComputeProfile &&
		selectedComputeProfile.name !== computeProfiles[0]?.name &&
		!session &&
		showRetry &&
		!defaultRetryAttempted;
	const showProfileSizeHint =
		!!selectedComputeProfile &&
		computeProfiles.length > 0 &&
		error?.kind === 'startup' &&
		error.generic === true;

	const backToProject = () => {
		void navigate(`/projects/${pid}`);
	};

	// NOTE: leaving the page (back/close) deliberately does NOT destroy the session —
	// the kernel keeps running so re-opening the notebook RESUMES it (the create-session
	// route returns the live session instead of provisioning a new sandbox). Heartbeats
	// stop when the page unmounts, so an abandoned session is reaped by the server's
	// heartbeat-TTL reaper. For the shared app this matters doubly: other people may
	// still be using it. Tearing down happens only on explicit Stop.
	const handleStop = () => {
		stop();
		backToProject();
	};
	const takeOver = () => {
		const holder = editorState?.holder;
		if (!holder || !editorState.can_take_over) return;
		takeover.mutate(
			{
				takeover_id: crypto.randomUUID(),
				expected_holder_session_id: holder.session_id,
				expected_activity: holder.activity.state,
				acknowledge_disruption: true,
			},
			{
				onSuccess: () => {
					confirmTakeover.close();
					setEditIntent(undefined);
					startPersistent();
				},
				onError: () => {
					confirmTakeover.close();
					void editorStateQuery.refetch();
				},
			},
		);
	};
	const sharedPersistentEditor =
		!isApp && session?.editor_sandbox_sharing === 'shared' && !session.ephemeral;

	return (
		<div className="flex h-dvh flex-col">
			<title>{`${title} · marimohub`}</title>
			<header className="flex h-10 min-h-10 items-center gap-2 border-b bg-background px-3 max-md:h-11 max-md:min-h-11">
				<IconLink
					to={`/projects/${pid}`}
					label="Back to project"
					variant="bordered"
					className="max-md:size-11"
				>
					<ArrowLeft className="size-4" />
				</IconLink>
				<div className="h-5 w-px bg-border" />
				<span className="truncate text-[13px] font-medium">{title}</span>
				{isApp && (
					<span className="flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary">
						<AppWindow className="size-3" />
						App
					</span>
				)}
				{!isApp && !isViewer && (
					<IconButton
						label="Rename notebook"
						tooltip="Rename notebook"
						size="sm"
						onPress={renameModal.open}
					>
						<Pencil className="size-3.5" />
					</IconButton>
				)}
				{!isApp && notebook?.source.type === 'git' && (
					<GitSourcePopover
						projectId={pid!}
						notebookId={nid!}
						triggerClassName="shrink-0 cursor-pointer rounded-full"
						trigger={
							<span className="flex max-w-[16rem] items-center gap-1 rounded-full border border-input px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary">
								<GitBranch className="size-3 shrink-0" />
								<span className="truncate">{notebook.source.repo}</span>
							</span>
						}
					/>
				)}
				{author && (
					<span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
						<span className="text-muted-foreground/70">· created by</span>
						<UserLabel user={users?.[author]} fallbackId={author} className="max-w-[10rem]" />
					</span>
				)}
				<div className="ml-auto flex items-center gap-2">
					{!staticView && (
						<ComputeProfileIndicator
							profiles={computeProfiles}
							storedName={notebook?.meta.compute_profile}
							allowOverride={computeOverrideApplies}
							hint={
								isViewer && !isApp
									? 'Shared views run on default compute'
									: !computeOverrideApplies && computeProfiles.length > 1
										? 'Managed by your operator'
										: undefined
							}
						/>
					)}
					{error ? (
						<Tooltip content="Error">
							<StatusDot className="bg-destructive" />
						</Tooltip>
					) : session ? (
						<SessionStatusDot
							session={session}
							profiles={computeProfiles}
							selectedProfileName={selectedComputeProfile?.name}
						/>
					) : (
						isProvisioning && (
							<Tooltip content="Starting">
								<StatusDot className="bg-yellow-500" pulse />
							</Tooltip>
						)
					)}
					{/* Stop/Restart render from the server-evaluated grants: editors on
					    the shared app, or the owner of their own ephemeral session. */}
					{isApp && session?.can?.stop && (
						<Button
							variant="unstyled"
							className="flex h-[26px] items-center gap-1 rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary max-md:min-h-11"
							onPress={() => confirmAppAction.open('restart')}
						>
							<RefreshCw className="size-3" />
							Restart
						</Button>
					)}
					{session?.can?.stop && (
						<Button
							variant="unstyled"
							className="flex h-[26px] items-center rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive max-md:min-h-11"
							onPress={
								isApp
									? () => confirmAppAction.open('stop')
									: sharedPersistentEditor
										? confirmEditStop.open
										: handleStop
							}
						>
							Stop
						</Button>
					)}
				</div>
			</header>

			{staticView && <StaticNotebookView projectId={pid!} notebookId={nid!} title={title} />}

			{showEditorChoice && editorState?.holder && (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
					<AlertTriangle className="size-8 text-amber-600" />
					<div className="flex max-w-lg flex-col gap-1">
						<p className="text-sm font-medium">{holderName} owns the saved editing session</p>
						<p className="text-sm text-muted-foreground">
							{activityWarning(holderName, editorState.holder.activity.state)}{' '}
							{editorState.can_take_over
								? 'Open an isolated temporary sandbox, or take over after saving and closing theirs.'
								: 'An editing transfer is already in progress. You can use an isolated temporary sandbox while it finishes.'}
						</p>
					</div>
					<div className="flex gap-2">
						<Button variant="default" onPress={() => setEditIntent('temporary')}>
							Open temporary sandbox
						</Button>
						<Button
							variant="primary"
							isDisabled={!editorState.can_take_over}
							onPress={confirmTakeover.open}
						>
							{editorState.can_take_over ? 'Take over editing' : 'Takeover in progress'}
						</Button>
					</div>
				</div>
			)}

			{editorStateFailed && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<AlertTriangle className="size-8 text-destructive" />
					<p className="max-w-md text-sm text-destructive">
						Unable to check who owns the editor sandbox.
					</p>
					<div className="flex gap-2">
						<Button
							variant="primary"
							isDisabled={editorStateQuery.isFetching}
							onPress={() => void editorStateQuery.refetch()}
						>
							{editorStateQuery.isFetching ? 'Checking...' : 'Retry'}
						</Button>
						<Button variant="ghost" onPress={backToProject}>
							Back
						</Button>
					</div>
				</div>
			)}

			{(isProvisioning || resolvingMode || (!isApp && !isViewer && !editorDecisionReady)) &&
				!editorStateFailed &&
				!showEditorChoice && (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
						<div
							className={cn(
								'size-8 rounded-full border-[3px] border-border border-t-primary',
								'animate-spin',
							)}
						/>
						<p>
							{resolvingMode ? 'Loading...' : isApp ? 'Starting app...' : 'Starting sandbox...'}
						</p>
					</div>
				)}

			{isRunning && (
				<>
					{session?.editor_sandbox_sharing === 'shared' && !session.ephemeral && (
						<div className="flex items-center gap-1.5 border-b bg-primary/5 px-3 py-1.5 text-xs text-muted-foreground">
							<Eye className="size-3.5 shrink-0" />
							<span>
								Trusted shared sandbox started by {sharedStarterName || 'another editor'} — other
								project editors may view and edit this session.
							</span>
						</div>
					)}
					{session?.ephemeral && (
						<div className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
							<Eye className="size-3.5 shrink-0" />
							<span>
								{isViewer
									? "You're a viewer on this project — this session is temporary and your changes won't be saved."
									: `Temporary sandbox — ${holderName || 'another editor'} owns saved editing. This sandbox is isolated and its changes won't be saved. Taking over will discard this temporary work.`}
							</span>
							{!isViewer && editorState?.holder && editorState.can_take_over && (
								<Button
									variant="unstyled"
									className="ml-auto text-xs underline"
									onPress={confirmTakeover.open}
								>
									Take over editing
								</Button>
							)}
						</div>
					)}
					{appStale && (
						<div
							aria-live="polite"
							className="flex items-center gap-1.5 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-muted-foreground"
						>
							<AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
							<span>
								The notebook has changed since this app started — it's serving an older version.
							</span>
							{/* Whoever may stop the app may restart it; others get only the hint. */}
							{session?.can?.stop && (
								<Button
									variant="unstyled"
									className="ml-1 shrink-0 rounded text-xs font-medium text-primary underline-offset-2 hover:underline"
									onPress={() => confirmAppAction.open('restart')}
								>
									Restart to update
								</Button>
							)}
						</div>
					)}
					{editStale && (
						<div
							aria-live="polite"
							className="flex items-center gap-1.5 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-muted-foreground"
						>
							<AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
							<span>
								This notebook was updated on GitHub since this session started — you're viewing an
								older version.
							</span>
							{session?.can?.stop && (
								<Button
									variant="unstyled"
									className="ml-1 shrink-0 rounded text-xs font-medium text-primary underline-offset-2 hover:underline"
									onPress={confirmEditRestart.open}
								>
									Restart to update
								</Button>
							)}
						</div>
					)}
					<div
						className={cn('flex-1 overflow-hidden', takeover.isPending && 'pointer-events-none')}
						aria-hidden={takeover.isPending || undefined}
					>
						<iframe
							className="size-full border-0"
							src={iframeSrc}
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
							allow="clipboard-read; clipboard-write"
							title={title}
						/>
					</div>
				</>
			)}

			{/* The session ended underneath an open app page (stopped by another
			    editor, lifetime expiry, crash, the notebook was deleted, or this
			    caller's access was revoked). A deliberate terminal panel — never an
			    error-toast loop, never an auto-restart (a restart would surprise
			    whoever stopped it). */}
			{terminal && (
				<div
					aria-live="polite"
					className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
				>
					<AppWindow className="size-8 text-muted-foreground" />
					<div className="flex flex-col gap-1">
						<p className="text-sm font-medium">{terminal.title}</p>
						<p className="max-w-md text-sm text-muted-foreground">{terminal.message}</p>
					</div>
					<div className="flex gap-2">
						{terminal.canRestart && (
							<Button variant="primary" onPress={start}>
								{isApp ? 'Restart app' : 'Start editing'}
							</Button>
						)}
						<Button variant="ghost" onPress={backToProject}>
							Back
						</Button>
					</div>
				</div>
			)}

			{error && !ended && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<p className="max-w-md text-sm text-destructive">{error.message}</p>
					{showProfileSizeHint && (
						<p className="max-w-md text-xs text-muted-foreground">
							This notebook uses profile {selectedComputeProfile.name} — a larger profile may be
							needed.
						</p>
					)}
					<div className="flex gap-2">
						{canRetryWithDefault && (
							<Button variant="primary" onPress={startWithDefault}>
								Retry with Default
							</Button>
						)}
						{showRetry && (
							<Button variant={canRetryWithDefault ? 'default' : 'primary'} onPress={start}>
								Retry
							</Button>
						)}
						<Button variant="ghost" onPress={backToProject}>
							Back
						</Button>
					</div>
				</div>
			)}

			{!isApp && (
				<RenameNotebookDialog
					isOpen={renameModal.isOpen}
					onClose={renameModal.close}
					projectId={pid!}
					notebook={{ id: nid!, title }}
				/>
			)}

			{!isApp && (
				<ConfirmDialog
					isOpen={confirmEditRestart.isOpen}
					onClose={confirmEditRestart.close}
					title={sharedPersistentEditor ? 'Restart Shared Sandbox' : 'Restart Session'}
					description={`Restart the session for "${title}" to load the latest version from GitHub? Changes made in this sandbox aren't synced back and will be lost.${
						sharedPersistentEditor
							? ` All connected editors will be disconnected.${sessionConnectionHint(session)}`
							: ''
					}`}
					confirmLabel="Restart"
					onConfirm={() => {
						confirmEditRestart.close();
						restart();
					}}
				/>
			)}

			{!isApp && (
				<ConfirmDialog
					isOpen={confirmEditStop.isOpen}
					onClose={confirmEditStop.close}
					title="Stop Shared Sandbox"
					description={`Stop the shared sandbox for "${title}"? All connected editors will be disconnected.${sessionConnectionHint(session ?? undefined)}`}
					confirmLabel="Stop Sandbox"
					onConfirm={() => {
						confirmEditStop.close();
						handleStop();
					}}
				/>
			)}

			{!isApp && editorState?.holder && editorState.can_take_over && (
				<ConfirmDialog
					isOpen={confirmTakeover.isOpen}
					onClose={takeover.isPending ? () => {} : confirmTakeover.close}
					title="Take Over Editing"
					description={`${activityWarning(holderName, editorState.holder.activity.state)} Their work will be saved, their sandbox will close, and connected users will be disconnected. Any work in your temporary sandbox will be discarded.`}
					confirmLabel="Take Over"
					pendingLabel="Saving and taking over..."
					isPending={takeover.isPending}
					onConfirm={takeOver}
				/>
			)}

			{isApp && (
				<ConfirmDialog
					isOpen={confirmAppAction.isOpen}
					onClose={confirmAppAction.close}
					title={confirmAppAction.target === 'restart' ? 'Restart App' : 'Stop App'}
					description={
						confirmAppAction.target === 'restart'
							? `Restart the app for "${title}"? It will come back serving the latest saved version — anyone using it now will be disconnected and must reopen it.${sessionConnectionHint(session ?? undefined)}`
							: `Stop the app for "${title}"? Anyone using it will be disconnected.${sessionConnectionHint(session ?? undefined)}`
					}
					confirmLabel={confirmAppAction.target === 'restart' ? 'Restart' : 'Stop App'}
					onConfirm={() => {
						const action = confirmAppAction.target;
						confirmAppAction.close();
						if (action === 'restart') restart();
						else handleStop();
					}}
				/>
			)}
		</div>
	);
}
