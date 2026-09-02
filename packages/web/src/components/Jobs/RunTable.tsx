import { useNow } from '@/hooks/useNow';
import { isTerminalRun, runDurationMs } from '@/lib/jobs';
import { formatAbsolute, formatElapsed, formatRelative } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { JobRun } from '@/types';
import { RunStatusChip } from './RunStatusChip';

interface RunTableProps {
	runs: JobRun[];
	selectedRunId: string | null;
	onSelect: (run: JobRun) => void;
}

export function RunTable({ runs, selectedRunId, onSelect }: RunTableProps) {
	const now = useNow(runs.some((run) => !isTerminalRun(run)) ? 1000 : null);
	if (runs.length === 0) {
		return <p className="text-xs text-muted-foreground">No runs yet.</p>;
	}
	return (
		<table className="w-full text-xs">
			<thead className="text-left text-muted-foreground">
				<tr className="border-b">
					<th className="py-1.5 pr-3 font-medium">Status</th>
					<th className="py-1.5 pr-3 font-medium">Trigger</th>
					<th className="py-1.5 pr-3 font-medium">Queued</th>
					<th className="py-1.5 pr-3 font-medium">Duration</th>
					<th className="py-1.5 font-medium">Attempt</th>
				</tr>
			</thead>
			<tbody>
				{runs.map((run) => {
					const duration = runDurationMs(run, now);
					return (
						<tr
							key={run.run_id}
							data-testid="run-row"
							onClick={() => onSelect(run)}
							className={cn(
								'cursor-pointer border-b transition-colors hover:bg-muted/50',
								run.run_id === selectedRunId && 'bg-muted',
							)}
						>
							<td className="py-1.5 pr-3">
								<RunStatusChip run={run} />
							</td>
							<td className="py-1.5 pr-3 capitalize">{run.trigger}</td>
							<td className="py-1.5 pr-3" title={formatAbsolute(run.queued_at)}>
								{formatRelative(run.queued_at)}
							</td>
							<td className="py-1.5 pr-3">{duration === null ? '—' : formatElapsed(duration)}</td>
							<td className="py-1.5">{run.attempt}</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
