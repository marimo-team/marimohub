import { RUN_STATUS_LABELS, runStatusClasses } from '@/lib/jobs';
import { cn } from '@/lib/utils';
import type { JobRun } from '@/types';

export function RunStatusChip({ run }: { run: Pick<JobRun, 'status'> }) {
	const live = run.status === 'provisioning' || run.status === 'running';
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
				runStatusClasses(run.status),
			)}
		>
			{live && (
				<span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
			)}
			{RUN_STATUS_LABELS[run.status]}
		</span>
	);
}
