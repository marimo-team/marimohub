import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Eye, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
	Button,
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
	useUsersQuery,
} from '@/api/hooks';
import { useNotebookSession } from '@/hooks/useNotebookSession';
import { useDisclosure } from '@/hooks/useDisclosure';
import { RenameNotebookDialog } from '@/components/Notebook/RenameNotebookDialog';
import { StaticNotebookView } from '@/components/NotebookPage/StaticNotebookView';

export function NotebookPage() {
	const { pid, nid } = useParams<{ pid: string; nid: string }>();
	const navigate = useNavigate();
	const location = useLocation();

	const notebookTitle = (location.state as { title?: string } | null)?.title ?? nid ?? 'Notebook';
	const renameModal = useDisclosure();

	// The viewer-mode branch (server-enforced regardless): editors get a session
	// as always; a viewer gets one only under MARIMOHUB_VIEWER_MODE=
	// ephemeral-sandbox, and the static snapshot view under `static`. The session
	// auto-start is held until the branch is decided so a viewer never fires a
	// doomed request; a failed capabilities probe falls back to `static` (the
	// server default) instead of spinning forever.
	const { data: project } = useProjectQuery(pid!);
	const { data: capabilities, isError: capabilitiesError } = useCapabilitiesQuery();
	const isViewer = project.your_role === 'viewer';
	// Resolved-but-missing (version skew with an older API) and a failed probe
	// both fall back to `static` — the server default — never an infinite spinner.
	const viewerMode = capabilities
		? (capabilities.viewer_mode ?? 'static')
		: capabilitiesError
			? 'static'
			: undefined;
	const staticView = isViewer && viewerMode === 'static';
	const resolvingMode = isViewer && viewerMode === undefined;

	const { session, error, isProvisioning, isRunning, sandboxUrl, start, stop } = useNotebookSession(
		pid!,
		nid!,
		{ enabled: !isViewer || viewerMode === 'ephemeral-sandbox' },
	);

	// Metadata for the "created by" line — loaded lazily so it never blocks the
	// kernel from starting. The author id is resolved to a name via the directory.
	const { data: notebook } = useNotebookQuery(pid!, nid!);
	const author = notebook?.meta.author;
	// Prefer the canonical title once detail loads, so a rename reflects immediately.
	const title = notebook?.meta.title ?? notebookTitle;
	const { data: users } = useUsersQuery(author ? [author] : []);

	const backToProject = () => {
		void navigate(`/projects/${pid}`);
	};

	// NOTE: leaving the page (back/close) deliberately does NOT destroy the session —
	// the kernel keeps running so re-opening the notebook RESUMES it (the create-session
	// route returns the live session instead of provisioning a new sandbox). Heartbeats
	// stop when the page unmounts, so an abandoned session is reaped by the server's
	// heartbeat-TTL reaper. Tearing down (and saving files back) happens on explicit Stop.
	const handleStop = () => {
		stop();
		backToProject();
	};

	return (
		<div className="flex h-dvh flex-col">
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
				{!isViewer && (
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
					{session && (
						<Button
							variant="unstyled"
							className="flex h-[26px] items-center rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive max-md:min-h-11"
							onPress={handleStop}
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
					<p>{resolvingMode ? 'Loading...' : 'Starting sandbox...'}</p>
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
					<div className="flex-1 overflow-hidden">
						<iframe
							className="size-full border-0"
							src={sandboxUrl}
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
							allow="clipboard-read; clipboard-write"
							title={title}
						/>
					</div>
				</>
			)}

			{error && (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
					<p className="max-w-md text-sm text-destructive">{error}</p>
					<div className="flex gap-2">
						<Button variant="primary" onPress={start}>
							Retry
						</Button>
						<Button variant="ghost" onPress={backToProject}>
							Back
						</Button>
					</div>
				</div>
			)}

			<RenameNotebookDialog
				isOpen={renameModal.isOpen}
				onClose={renameModal.close}
				projectId={pid!}
				notebook={{ id: nid!, title }}
			/>
		</div>
	);
}
