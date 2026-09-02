import { useState } from 'react';
import { XCircle } from 'lucide-react';
import { useJobRunHtmlQuery, useJobRunLogsQuery, useUsersQuery } from '@/api/hooks';
import { Button, Skeleton, UserLabel } from '@/components/ui';
import { useNow } from '@/hooks/useNow';
import { isTerminalRun, runDurationMs } from '@/lib/jobs';
import { formatAbsolute, formatElapsed, formatRelative } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Job, JobRun } from '@/types';
import { RunStatusChip } from './RunStatusChip';

interface RunDetailProps {
	projectId: string;
	notebookId: string;
	job: Job;
	run: JobRun;
	canEdit: boolean;
	onCancel: (run: JobRun) => void;
}

export function RunDetail({ projectId, notebookId, job, run, canEdit, onCancel }: RunDetailProps) {
	const [tab, setTab] = useState<'output' | 'logs'>('output');
	const now = useNow(isTerminalRun(run) ? null : 1000);
	const terminal = isTerminalRun(run);
	const html = useJobRunHtmlQuery(projectId, notebookId, job.id, run.run_id, terminal);
	const logs = useJobRunLogsQuery(
		projectId,
		notebookId,
		job.id,
		run.run_id,
		terminal && canEdit && tab === 'logs',
	);
	const duration = runDurationMs(run, now);
	const { data: users } = useUsersQuery([run.triggered_by, run.cancelled_by]);

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={`Run ${run.run_id}`}>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<RunStatusChip run={run} />
				<span>
					{run.trigger === 'schedule' ? (
						<>Scheduled for {formatAbsolute(run.scheduled_for)}</>
					) : (
						<>
							Run manually
							{run.triggered_by && (
								<>
									{' by '}
									<UserLabel
										user={users?.[run.triggered_by]}
										fallbackId={run.triggered_by}
										className="max-w-[10rem]"
									/>
								</>
							)}
						</>
					)}
				</span>
				{run.attempt > 1 && <span>Attempt {run.attempt}</span>}
				<span>Queued {formatRelative(run.queued_at)}</span>
				{run.started_at && <span>Started {formatAbsolute(run.started_at)}</span>}
				{duration !== null && <span>Duration {formatElapsed(duration)}</span>}
				{run.exit_code !== undefined && <span>Exit {run.exit_code}</span>}
				{run.compute_profile && <span>Compute {run.compute_profile}</span>}
				{run.image && (
					<span className="max-w-[16rem] truncate" title={run.image}>
						Image {run.image}
					</span>
				)}
				{canEdit && !terminal && (
					<Button variant="ghost" size="sm" onPress={() => onCancel(run)}>
						<XCircle className="size-3.5" />
						Cancel run
					</Button>
				)}
			</div>
			{run.error && (
				<p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					<span className="font-medium">{run.error.code}</span> — {run.error.message}
				</p>
			)}
			{terminal ? (
				<>
					<div className="flex gap-1 border-b">
						{(['output', 'logs'] as const).map((key) => (
							<button
								key={key}
								type="button"
								onClick={() => setTab(key)}
								disabled={key === 'logs' && !canEdit}
								className={cn(
									'-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
									tab === key
										? 'border-primary text-foreground'
										: 'border-transparent text-muted-foreground hover:text-foreground',
								)}
							>
								{key === 'output' ? 'Output' : 'Logs'}
							</button>
						))}
					</div>
					{tab === 'output' ? (
						html.isPending ? (
							<Skeleton className="h-40 w-full" />
						) : html.data ? (
							<div className="min-h-[24rem] flex-1 overflow-hidden rounded-md border">
								<iframe
									className="size-full min-h-[24rem] border-0"
									srcDoc={html.data}
									sandbox="allow-scripts"
									title={`${job.name} output`}
								/>
							</div>
						) : (
							<p className="text-xs text-muted-foreground">This run produced no output.</p>
						)
					) : logs.isPending ? (
						<Skeleton className="h-40 w-full" />
					) : (
						<pre className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
							{logs.data ?? 'No logs were captured.'}
						</pre>
					)}
				</>
			) : (
				<p className="text-xs text-muted-foreground">
					{run.status === 'queued'
						? 'Waiting for the scheduler to pick this run up.'
						: 'The notebook is running in its own sandbox; output appears when it finishes.'}
				</p>
			)}
		</section>
	);
}
