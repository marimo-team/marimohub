import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useNotebookQuery } from '@/api/hooks';
import { Popover } from '@/components/ui';
import { formatRelative } from '@/lib/time';
import {
	gitEntryPath,
	githubBranchUrl,
	githubCommitUrl,
	githubCoords,
	githubRepoUrl,
	githubSourceUrl,
	shortCommit,
} from '@/lib/github';

const LINK_CLASSES = 'text-primary underline-offset-2 hover:underline';

function GitSourceDetails({ projectId, notebookId }: { projectId: string; notebookId: string }) {
	// Lazy (popover-open only) fetch; `staleTime: 0` because a background push
	// can advance the source underneath a cached read and nothing invalidates it.
	const { data: notebook, isError } = useNotebookQuery(projectId, notebookId, { staleTime: 0 });
	const source = notebook?.source.type === 'git' ? notebook.source : undefined;
	// Null when no trustworthy GitHub link exists (non-github provider, or a repo
	// that isn't plain owner/repo) — metadata then renders without links.
	const coords = githubCoords(notebook?.source);

	if (isError) {
		return <p className="text-xs text-destructive">Failed to load sync details.</p>;
	}
	if (!source) {
		return <p className="text-xs text-muted-foreground">Loading sync details...</p>;
	}
	return (
		<div className="flex min-w-[14rem] flex-col gap-2 text-xs">
			<div className="font-medium text-foreground">Synced from GitHub</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
				<dt>Repository</dt>
				<dd className="min-w-0 truncate">
					{coords ? (
						<a
							href={githubRepoUrl(coords.repo)}
							target="_blank"
							rel="noreferrer"
							className={LINK_CLASSES}
						>
							{source.repo}
						</a>
					) : (
						<span className="text-foreground">{source.repo}</span>
					)}
				</dd>
				<dt>Branch</dt>
				<dd className="min-w-0 truncate">
					{coords ? (
						<a
							href={githubBranchUrl(coords.repo, coords.branch)}
							target="_blank"
							rel="noreferrer"
							className={LINK_CLASSES}
						>
							{source.branch}
						</a>
					) : (
						<span className="text-foreground">{source.branch}</span>
					)}
				</dd>
				<dt>File</dt>
				<dd className="min-w-0 truncate">
					{coords ? (
						<a
							href={githubSourceUrl(coords)}
							target="_blank"
							rel="noreferrer"
							className={LINK_CLASSES}
						>
							{gitEntryPath(source)}
						</a>
					) : (
						<span className="text-foreground">{gitEntryPath(source)}</span>
					)}
				</dd>
				{source.commit && (
					<>
						<dt>Commit</dt>
						<dd>
							{coords ? (
								<a
									href={githubCommitUrl(coords.repo, source.commit)}
									target="_blank"
									rel="noreferrer"
									className={`font-mono ${LINK_CLASSES}`}
								>
									{shortCommit(source.commit)}
								</a>
							) : (
								<span className="font-mono text-foreground">{shortCommit(source.commit)}</span>
							)}
						</dd>
					</>
				)}
				<dt>Synced</dt>
				<dd className="text-foreground">
					{source.last_synced_at ? formatRelative(source.last_synced_at) : 'Not synced yet'}
				</dd>
			</dl>
			{coords && (
				<a
					href={githubSourceUrl(coords)}
					target="_blank"
					rel="noreferrer"
					className={`flex items-center gap-1 pt-0.5 font-medium ${LINK_CLASSES}`}
				>
					View source on GitHub
					<ExternalLink className="size-3" />
				</a>
			)}
		</div>
	);
}

/**
 * GitHub metadata behind a compact trigger (the project row's git tile, the
 * editor's repo chip): repo/branch/file/commit with links, loaded only while
 * the popover is open.
 */
export function GitSourcePopover({
	projectId,
	notebookId,
	trigger,
	triggerClassName,
}: {
	projectId: string;
	notebookId: string;
	trigger: ReactNode;
	triggerClassName?: string;
}) {
	return (
		<Popover
			label="Synced from GitHub — details"
			tooltip="Synced from GitHub"
			trigger={trigger}
			triggerClassName={triggerClassName}
		>
			<GitSourceDetails projectId={projectId} notebookId={notebookId} />
		</Popover>
	);
}
