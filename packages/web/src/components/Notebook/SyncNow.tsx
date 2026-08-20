import { toast } from 'sonner';
import { useCapabilitiesQuery, useSourceDriftQuery, useSyncNotebookNow } from '@/api/hooks';
import { isApiErrorCode } from '@/api/request';
import { Button } from '@/components/ui';
import { shortCommit } from '@/lib/git';
import { cn } from '@/lib/utils';

/**
 * Whether this deployment can server-pull the given source — the first gate
 * for drift/Sync-now chrome. Deploy-skew tolerant: a server without the
 * capability field grants nothing. Pending settings can move the source to
 * another provider while the stored provider only updates on promotion, so
 * with anything pending any configured reader is enough to probe — the
 * server's drift answer is authoritative and SYNC_NOT_CONFIGURED hides the row.
 */
function useServerSyncGate(
	source: { provider: string | null; pending_config?: unknown } | undefined,
): boolean {
	const { data: capabilities } = useCapabilitiesQuery();
	const providers = capabilities?.source_control?.sync_providers ?? [];
	if (!source) return false;
	if (source.pending_config) return providers.length > 0;
	return !!source.provider && providers.includes(source.provider);
}

function SourceDriftLine({
	drift,
	branch,
}: {
	drift: ReturnType<typeof useSourceDriftQuery>;
	branch: string;
}) {
	if (drift.isError) return null;
	if (!drift.data) {
		return <span className="text-xs text-muted-foreground">Checking sync status...</span>;
	}
	const { in_sync, pending_config, current_commit, remote_commit } = drift.data;
	if (pending_config) {
		return <span className="text-xs text-muted-foreground">Pending settings awaiting sync</span>;
	}
	if (in_sync) {
		return (
			<span className="text-xs text-muted-foreground">
				In sync at <span className="font-mono">{shortCommit(remote_commit)}</span>
			</span>
		);
	}
	return (
		<span className="text-xs text-amber-600 dark:text-amber-500">
			Behind <span className="font-medium">{branch}</span> (synced{' '}
			<span className="font-mono">{current_commit ? shortCommit(current_commit) : 'never'}</span>,
			head <span className="font-mono">{shortCommit(remote_commit)}</span>)
		</span>
	);
}

function SyncNowButton({ projectId, notebookId }: { projectId: string; notebookId: string }) {
	const syncNow = useSyncNotebookNow(projectId);
	return (
		<Button
			type="button"
			size="sm"
			isDisabled={syncNow.isPending}
			onPress={() =>
				syncNow.mutate(notebookId, {
					onSuccess: (data) => {
						toast.success(
							data.synced ? `Synced to ${shortCommit(data.commit)}` : 'Already up to date',
						);
					},
				})
			}
		>
			{syncNow.isPending ? 'Syncing...' : 'Sync now'}
		</Button>
	);
}

/**
 * The complete server-sync chrome: drift line + Sync now button. Renders
 * nothing unless `enabled` (the caller's role check) and the deployment can
 * pull the source, so call sites need no gating of their own. The capability
 * list is provider-granular while support is repository-granular (a GitHub
 * Enterprise source shares the `github` provider id but stays push-only), so
 * the server's SYNC_NOT_CONFIGURED answer on the drift probe hides the row too.
 */
export function ServerSyncRow({
	projectId,
	notebookId,
	source,
	enabled = true,
	className,
}: {
	projectId: string;
	notebookId: string;
	source: { provider: string | null; branch: string; pending_config?: unknown } | undefined;
	/** The caller's role check — pass false for viewers. */
	enabled?: boolean;
	className?: string;
}) {
	const gate = (useServerSyncGate(source) && enabled) || false;
	const drift = useSourceDriftQuery(projectId, notebookId, gate);
	if (!gate || !source) return null;
	if (isApiErrorCode(drift.error, 'SYNC_NOT_CONFIGURED')) return null;
	return (
		<div className={cn('flex items-center justify-between gap-3', className)}>
			<SourceDriftLine drift={drift} branch={source.branch} />
			<SyncNowButton projectId={projectId} notebookId={notebookId} />
		</div>
	);
}
