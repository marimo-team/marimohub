import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera } from 'lucide-react';
import { Chip, IconLink } from '@/components/ui';
import { useNotebookQuery } from '@/api/hooks';
import { StaticNotebookView } from '@/components/NotebookPage/StaticNotebookView';

/**
 * Full-screen view of a notebook's HTML snapshot ("View static outputs"): the
 * latest by default, or one version's via `?version=` (from Version history).
 * Compute-free: no session is ever started; the snapshot renders in
 * StaticNotebookView's opaque-origin iframe.
 */
export function SnapshotPage() {
	const { pid, nid } = useParams<{ pid: string; nid: string }>();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const versionId = searchParams.get('version') ?? undefined;
	const fallbackTitle = (location.state as { title?: string } | null)?.title ?? nid ?? 'Notebook';
	const { data: notebook } = useNotebookQuery(pid!, nid!);
	// Prefer the canonical title once detail loads, so a rename reflects immediately.
	const title = notebook?.meta.title ?? fallbackTitle;

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
				<Chip>
					<Camera className="size-3" />
					Snapshot
				</Chip>
			</header>
			<StaticNotebookView
				projectId={pid!}
				notebookId={nid!}
				title={title}
				variant="standalone"
				versionId={versionId}
				headVersionId={notebook?.source.current_version_id ?? undefined}
			/>
		</div>
	);
}
