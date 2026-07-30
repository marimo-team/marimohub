import { useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { AlertTriangle, AppWindow, ArrowLeft, Eye, Pencil, RefreshCw } from 'lucide-react';
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
	useUsersQuery,
} from '@/api/hooks';
import { useNotebookSession } from '@/hooks/useNotebookSession';
import type { SessionEnded } from '@/hooks/useNotebookSession';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useDisclosure } from '@/hooks/useDisclosure';
import { RenameNotebookDialog } from '@/components/Notebook/RenameNotebookDialog';
import { StaticNotebookView } from '@/components/NotebookPage/StaticNotebookView';
import { isAppStale } from '@/components/Project/AppSessionIndicator';
import { appConnectionHint, sessionsByNotebook } from '@/lib/sessions';
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

	const { session, error, isProvisioning, isRunning, sandboxUrl, ended, start, stop, restart } =
		useNotebookSession(pid!, nid!, {
			enabled: isApp || !isViewer || viewerHasEditKernel,
			mode: isApp ? 'app' : 'edit',
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
	// On the app page it also carries the head version for the staleness banner,
	// which must track versions committed server-side (snapshotter, teardown) —
	// hence the poll; a cached-once head would never fire (or mis-fire) the banner.
	const { data: notebook } = useNotebookQuery(
		pid!,
		nid!,
		isApp ? { refetchIntervalMs: 30_000 } : {},
	);
	const author = notebook?.meta.author;
	// Prefer the canonical title once detail loads, so a rename reflects immediately.
	const title = notebook?.meta.title ?? notebookTitle;
	const { data: users } = useUsersQuery(author ? [author] : []);

	// App pages watch the project's sessions (5s poll) to know whether the
	// notebook is being edited: the periodic snapshotter commits a version every
	// ~2 minutes mid-edit, so the staleness banner is suppressed until editing
	// stops — otherwise it would flap (with a disconnect-everyone CTA) the whole
	// time someone types.
	// Stops once the app has ended — the banner it feeds is gone with the iframe.
	const { data: projectSessions } = useProjectSessionsQuery(pid!, isApp && !ended);
	const sessionByNotebook = useMemo(() => sessionsByNotebook(projectSessions), [projectSessions]);
	const editActive = isApp && !!sessionByNotebook.get(nid!)?.edit;
	const appStale =
		isApp && !!session && !editActive && isAppStale(session, notebook?.source.current_version_id);
	// A viewer deep-linking to /app gets a plain 403 panel; retrying can only
	// fail again, so the button is dropped (no retry loop, manual or otherwise).
	const showRetry = error?.code !== 'FORBIDDEN';
	const terminal = isApp && ended && !isProvisioning ? endedPanel(ended) : null;

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
				{author && (
					<span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
						<span className="text-muted-foreground/70">· created by</span>
						<UserLabel user={users?.[author]} fallbackId={author} className="max-w-[10rem]" />
					</span>
				)}
				<div className="ml-auto flex items-center gap-2">
					{error ? (
						<Tooltip content="Error">
							<StatusDot className="bg-destructive" />
						</Tooltip>
					) : session ? (
						<SessionStatusDot session={session} />
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
							onPress={isApp ? () => confirmAppAction.open('stop') : handleStop}
						>
							Stop
						</Button>
					)}
				</div>
			</header>

			{staticView && <StaticNotebookView projectId={pid!} notebookId={nid!} title={title} />}

			{(isProvisioning || resolvingMode) && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
					<div
						className={cn(
							'size-8 rounded-full border-[3px] border-border border-t-primary',
							'animate-spin',
						)}
					/>
					<p>{resolvingMode ? 'Loading...' : isApp ? 'Starting app...' : 'Starting sandbox...'}</p>
				</div>
			)}

			{isRunning && (
				<>
					{session?.ephemeral && (
						<div className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
							<Eye className="size-3.5 shrink-0" />
							<span>
								You're a viewer on this project — this session is temporary and your changes won't
								be saved.
							</span>
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
					<div className="flex-1 overflow-hidden">
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
								Restart app
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
					<div className="flex gap-2">
						{showRetry && (
							<Button variant="primary" onPress={start}>
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

			{isApp && (
				<ConfirmDialog
					isOpen={confirmAppAction.isOpen}
					onClose={confirmAppAction.close}
					title={confirmAppAction.target === 'restart' ? 'Restart App' : 'Stop App'}
					description={
						confirmAppAction.target === 'restart'
							? `Restart the app for "${title}"? It will come back serving the latest saved version — anyone using it now will be disconnected and must reopen it.${appConnectionHint(session ?? undefined)}`
							: `Stop the app for "${title}"? Anyone using it will be disconnected.${appConnectionHint(session ?? undefined)}`
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
