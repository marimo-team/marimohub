import { CheckCircle2, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { TOOL_STATUS_LABELS, toolLabel } from './toolActivityModel';
import type { ToolActivityEntry, ToolStatus } from './toolActivityModel';
import { PermissionCard } from './PermissionCard';
import type { DecidePermission } from './PermissionCard';
import { cn } from '@/lib/utils';

function ToolStatusIcon({ status }: { status: ToolStatus }) {
	switch (status) {
		case 'running':
			return (
				<LoaderCircle
					className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
					aria-hidden
				/>
			);
		case 'failed':
			return <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />;
		case 'succeeded':
			return (
				<CheckCircle2
					className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
					aria-hidden
				/>
			);
	}
}

export function ToolActivity({
	calls,
	onDecide,
	onInspect,
	inspecting,
}: {
	calls: readonly ToolActivityEntry[];
	onDecide?: DecidePermission;
	/** Opens the call in the inspector; rows are plain text without it. */
	onInspect?: (toolCallId: string) => void;
	inspecting?: string | null;
}) {
	if (calls.length === 0) return null;
	return (
		<section aria-label="marimohub tool activity" className="my-1">
			<ul className="space-y-2">
				{calls.map((call) => {
					const row = (
						<>
							<span className="flex min-w-0 items-center gap-1.5 capitalize">
								{onInspect ? (
									<ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
								) : null}
								<span className="truncate">{toolLabel(call.name)}</span>
							</span>
							<span
								className={cn(
									'shrink-0',
									call.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
								)}
							>
								{TOOL_STATUS_LABELS[call.status]}
							</span>
						</>
					);
					return (
						<li key={call.id} className="flex gap-2.5 text-xs">
							<ToolStatusIcon status={call.status} />
							<div className="min-w-0 flex-1">
								{onInspect ? (
									<button
										type="button"
										aria-label={`Inspect ${toolLabel(call.name)} (${TOOL_STATUS_LABELS[call.status]})`}
										aria-pressed={inspecting === call.id}
										onClick={() => onInspect(call.id)}
										className={cn(
											'-mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring',
											inspecting === call.id && 'bg-accent',
										)}
									>
										{row}
									</button>
								) : (
									<div className="flex items-center justify-between gap-2 py-0.5">{row}</div>
								)}
								{call.summary ? (
									<p className="mt-1 break-words text-muted-foreground">{call.summary}</p>
								) : null}
								{call.permission && (
									<PermissionCard
										key={call.permission.id}
										permission={call.permission}
										onDecide={onDecide}
									/>
								)}
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function ChatProgress({
	calls,
	writing = false,
}: {
	calls: readonly ToolActivityEntry[];
	/** Text is arriving right now, so the model is past planning. */
	writing?: boolean;
}) {
	const runningCalls = calls.filter((call) => call.status === 'running');
	const running = runningCalls.at(-1);
	const waitingForConsent = runningCalls.some((call) => call.permission?.status === 'open');
	let message = writing || calls.length > 0 ? 'Writing…' : 'Planning the next step…';
	if (running) message = `Running ${toolLabel(running.name)}…`;
	if (waitingForConsent) message = 'Waiting for your permission…';
	return (
		<div className="flex gap-3 text-sm text-muted-foreground">
			<LoaderCircle
				className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
				aria-hidden
			/>
			<div>
				<output className="block" aria-live="polite">
					{message}
				</output>
				{running && !waitingForConsent ? (
					<p className="mt-1 text-xs">
						Some operations take a few minutes. Progress is saved in this conversation.
					</p>
				) : null}
			</div>
		</div>
	);
}
