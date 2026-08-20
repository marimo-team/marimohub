import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useNotebookQuery } from '@/api/hooks';
import { ServerSyncRow } from '@/components/Notebook/SyncNow';
import { Popover } from '@/components/ui';
import { formatRelative } from '@/lib/time';
import {
	gitBranchUrl,
	gitCommitUrl,
	gitCoords,
	gitEntryPath,
	gitSourceUrl,
	providerLabel,
	shortCommit,
} from '@/lib/git';

const LINK_CLASSES = 'text-primary underline-offset-2 hover:underline';

function GitSourceDetails({
	projectId,
	notebookId,
	canSync = false,
}: {
	projectId: string;
	notebookId: string;
	canSync?: boolean;
}) {
	// Lazy (popover-open only) fetch; `staleTime: 0` because a background push
	// can advance the source underneath a cached read and nothing invalidates it.
	const { data: notebook, isError } = useNotebookQuery(projectId, notebookId, { staleTime: 0 });
	const source = notebook?.source.type === 'git' ? notebook.source : undefined;
	// Null when no trustworthy host link exists (unrecognized host, or a repo
	// that isn't owner/repo or a URL) — metadata then renders without links.
	const coords = gitCoords(notebook?.source);

	if (isError) {
		return <p className="text-xs text-destructive">Failed to load sync details.</p>;
	}
	if (!source) {
		return <p className="text-xs text-muted-foreground">Loading sync details...</p>;
	}
	return (
		<div className="flex min-w-[14rem] flex-col gap-2 text-xs">
			<div className="font-medium text-foreground">
				{coords ? `Synced from ${providerLabel(coords.provider)}` : 'Synced from a git repository'}
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
				<dt>Repository</dt>
				<dd className="min-w-0 truncate">
					{coords ? (
						<a href={coords.baseUrl} target="_blank" rel="noreferrer" className={LINK_CLASSES}>
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
							href={gitBranchUrl(coords, coords.branch)}
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
							href={gitSourceUrl(coords)}
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
									href={gitCommitUrl(coords, source.commit)}
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
			<ServerSyncRow
				projectId={projectId}
				notebookId={notebookId}
				source={source}
				enabled={canSync}
				className="border-t pt-2"
			/>
			{coords && (
				<a
					href={gitSourceUrl(coords)}
					target="_blank"
					rel="noreferrer"
					className={`flex items-center gap-1 pt-0.5 font-medium ${LINK_CLASSES}`}
				>
					View source on {providerLabel(coords.provider)}
					<ExternalLink className="size-3" />
				</a>
			)}
		</div>
	);
}

/**
 * Git-host metadata behind a compact trigger (the project row's git tile, the
 * editor's repo chip): repo/branch/file/commit with links, loaded only while
 * the popover is open.
 */
export function GitSourcePopover({
	projectId,
	notebookId,
	trigger,
	triggerClassName,
	canSync,
}: {
	projectId: string;
	notebookId: string;
	trigger: ReactNode;
	triggerClassName?: string;
	/** Show drift + Sync now (the viewer must be an editor; the provider gate is internal). */
	canSync?: boolean;
}) {
	return (
		<Popover
			label="Synced from a git repository — details"
			tooltip="Synced from a git repository"
			trigger={trigger}
			triggerClassName={triggerClassName}
		>
			<GitSourceDetails projectId={projectId} notebookId={notebookId} canSync={canSync} />
		</Popover>
	);
}
