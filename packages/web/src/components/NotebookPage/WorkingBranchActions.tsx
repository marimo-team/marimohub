import { GitCommitHorizontal, GitPullRequest } from 'lucide-react';
import { toast } from 'sonner';
import { useOpenBranchPR, useSaveToBranch, useWorkingBranch } from '@/api/workingBranches';
import { Button } from '@/components/ui/Button';
import { withBasePath } from '@/lib/basePath';

export function WorkingBranchActions({
	projectId,
	notebookId,
	sessionId,
	canWrite,
	canManage = false,
	userId,
	onSaved,
}: {
	projectId: string;
	notebookId: string;
	sessionId?: string;
	canWrite: boolean;
	canManage?: boolean;
	userId?: string;
	onSaved?: (sessionId: string, versionId: string) => void;
}) {
	const status = useWorkingBranch(projectId, notebookId, canWrite);
	const save = useSaveToBranch(projectId, notebookId);
	const open = useOpenBranchPR(projectId, notebookId);
	if (!canWrite) return null;
	const data = status.data;
	const last = data?.last_save;
	const pr = data?.change_request;
	const recoveryExpired =
		last &&
		[
			'claimed',
			'captured',
			'commit_prepared',
			'complete',
			'no_changes',
			'conflict',
			'expired',
		].includes(last.state) &&
		Date.parse(last.expires_at) <= Date.now();
	const canRecover = !!last && (canManage || last.author === userId);
	const ended = data?.ended_reason || (pr && pr.state !== 'open') || data?.remote_commit === null;
	const busy = save.isPending || open.isPending;
	const error = save.error ?? open.error ?? status.error;
	const pending = data?.active_save;
	const label = save.isPending ? 'Saving…' : pending ? 'Retry save' : 'Save to branch';
	return (
		<div className="flex flex-wrap items-center justify-end gap-2 text-xs">
			<Button
				size="sm"
				variant="default"
				isDisabled={!data || busy || (!pending && (!sessionId || !!ended)) || status.isError}
				onPress={() =>
					save.mutate(
						{ sessionId, operationId: pending },
						{
							onSuccess: (result) => {
								if (result.state === 'complete') {
									if (result.version_id) onSaved?.(result.session_id, result.version_id);
									toast.success('Committed to working branch');
								} else if (result.state === 'no_changes') toast.info('No source changes to save');
								else toast.warning(result.error ?? 'Save needs completion');
							},
						},
					)
				}
			>
				<GitCommitHorizontal className="size-3.5" />
				{label}
			</Button>
			{pr ? (
				<a href={pr.url} target="_blank" rel="noreferrer" className="text-primary underline">
					View PR · {pr.state}
				</a>
			) : (
				<Button
					size="sm"
					variant="default"
					isDisabled={busy || !!pending || !!ended || !data}
					onPress={() => open.mutate()}
				>
					<GitPullRequest className="size-3.5" />
					{open.isPending ? 'Opening…' : 'Open PR'}
				</Button>
			)}
			{last && (
				<output className="text-muted-foreground">
					{last.state === 'complete' || last.state === 'no_changes'
						? `Saved ${last.commit?.slice(0, 8) ?? ''}`
						: (last.error ?? `Save: ${last.state}`)}
				</output>
			)}
			{last && canRecover && last.changes.length > 0 && !recoveryExpired && (
				<a
					className="text-primary underline"
					href={withBasePath(
						`/api/v1/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(notebookId)}/working-branch/saves/${last.id}/recovery`,
					)}
					download
					title={`Captured source files; expiry ${last.expires_at}`}
				>
					Download recovery
				</a>
			)}
			{recoveryExpired && canRecover && last.changes.length > 0 && (
				<span className="text-muted-foreground">Recovery capture expired.</span>
			)}
			{ended && (
				<span className="text-muted-foreground">Start a new branch to continue publishing.</span>
			)}
			{status.isError && (
				<Button
					size="sm"
					variant="default"
					isDisabled={status.isFetching}
					onPress={() => void status.refetch()}
				>
					Retry status
				</Button>
			)}
			{error && (
				<span role="alert" className="text-destructive">
					{error.message}
				</span>
			)}
		</div>
	);
}
