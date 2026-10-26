import { Camera, Play } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { LinkButton } from '@/components/ui/Button';
import { notebookAppUrl } from '@/lib/notebookUrls';
import { cn } from '@/lib/utils';
import { useNotebookHtmlQuery } from '@/api/hooks';
import { formatRelative } from '@/lib/time';

interface StaticNotebookViewProps {
	projectId: string;
	notebookId: string;
	title: string;
	canRunApp?: boolean;
	/** Banner copy: the role-gated viewer fallback vs the standalone SnapshotPage. */
	variant?: 'viewer' | 'standalone';
	/** Pin to one version's snapshot instead of the newest available. */
	versionId?: string;
	/** The notebook's current head; when the snapshot trails it, the banner says so. */
	headVersionId?: string;
}

/**
 * The notebook's last captured HTML snapshot (from a past editor session's
 * teardown), or an empty state when none exists yet. Shown to viewers whose
 * mode grants no edit kernel (MARIMOHUB_VIEWER_MODE=static or applications)
 * and on the standalone SnapshotPage. The snapshot is user-generated HTML, so
 * it renders in an iframe WITHOUT `allow-same-origin` — an opaque origin,
 * unlike the live-kernel iframe (the server's CSP `sandbox` header is the
 * second layer).
 */
export function StaticNotebookView({
	projectId,
	notebookId,
	title,
	canRunApp = false,
	variant = 'viewer',
	versionId,
	headVersionId,
}: StaticNotebookViewProps) {
	const location = useLocation();
	const { data, isPending, isError } = useNotebookHtmlQuery(projectId, notebookId, versionId);

	const capturedFrom = data?.capturedAt ? ` from ${formatRelative(data.capturedAt)}` : '';
	const stale = !!data?.versionId && !!headVersionId && data.versionId !== headVersionId;
	const canOpenApp = variant === 'viewer' && canRunApp;
	const viewerMessage = canOpenApp
		? 'run as an app to interact with this notebook.'
		: 'sessions are disabled for viewers.';
	const snapshotMessage =
		variant === 'viewer'
			? viewerMessage
			: stale
				? 'the notebook has changed since these outputs were captured.'
				: 'captured when the last editing session ended.';
	const banner =
		data && !isError
			? `Static snapshot of outputs${capturedFrom} — ${snapshotMessage}`
			: variant === 'viewer'
				? `You're a viewer on this project — ${viewerMessage}`
				: null;

	return (
		<>
			{banner && (
				<div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
					<Camera className="size-3.5 shrink-0" />
					<span>{banner}</span>
					{canOpenApp && (
						<LinkButton
							to={notebookAppUrl(projectId, notebookId, location.search)}
							state={{ title }}
							size="sm"
							className="ml-auto"
						>
							<Play className="size-3.5" />
							Run as app
						</LinkButton>
					)}
				</div>
			)}
			{isPending ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
					<div
						className={cn(
							'size-8 rounded-full border-[3px] border-border border-t-primary',
							'animate-spin',
						)}
					/>
					<p>Loading outputs...</p>
				</div>
			) : isError ? (
				<div className="flex flex-1 items-center justify-center p-6 text-center">
					<p className="max-w-md text-sm text-destructive">Failed to load the notebook outputs.</p>
				</div>
			) : data ? (
				<div className="flex-1 overflow-hidden">
					<iframe
						className="size-full border-0"
						srcDoc={data.html}
						sandbox="allow-scripts"
						title={title}
					/>
				</div>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
					<p className="text-sm font-medium">
						{versionId ? 'No outputs for this version' : 'No outputs yet'}
					</p>
					<p className="max-w-md text-sm text-muted-foreground">
						{versionId
							? 'This version captured no outputs, or they have since been cleaned up.'
							: canOpenApp
								? 'Run this notebook as an app to view its live outputs.'
								: 'An editor needs to run this notebook before its outputs can be viewed.'}
					</p>
				</div>
			)}
		</>
	);
}
