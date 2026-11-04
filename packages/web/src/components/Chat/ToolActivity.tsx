import { CheckCircle2, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ToolActivityEntry, ToolStatus } from './toolActivityModel';
import { PermissionCard } from './PermissionCard';
import type { DecidePermission } from './PermissionCard';

const labels = { running: 'Running', succeeded: 'Completed', failed: 'Failed' } as const;

export function toolLabel(name: string): string {
	return name.replaceAll('_', ' ');
}

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
}: {
	calls: readonly ToolActivityEntry[];
	onDecide?: DecidePermission;
}) {
	if (calls.length === 0) return null;
	return (
		<section aria-label="marimohub tool activity" className="my-3 rounded-lg border bg-card/60 p-3">
			<p className="mb-2 text-xs font-medium text-muted-foreground">Tool activity</p>
			<ul className="space-y-3">
				{calls.map((call) => (
					<li key={call.id} className="flex gap-2.5 text-xs">
						<ToolStatusIcon status={call.status} />
						<div className="min-w-0 flex-1">
							<details className="group">
								<summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
									<span className="flex items-center gap-1.5 capitalize">
										<ChevronRight
											className="size-3 transition-transform group-open:rotate-90"
											aria-hidden
										/>
										{toolLabel(call.name)}
									</span>
									<span
										className={
											call.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
										}
									>
										{labels[call.status]}
									</span>
								</summary>
								<div className="mt-3 space-y-3 rounded-md border bg-background/70 p-3">
									<p className="font-mono text-muted-foreground">{call.name}</p>
									<ToolPreview label="Input preview" value={call.input_preview} />
									<ToolPreview
										label={call.status === 'failed' ? 'Error details' : 'Result preview'}
										value={call.output_preview}
									/>
									{!call.input_preview && !call.output_preview ? (
										<p className="text-muted-foreground">Details were not saved for this call.</p>
									) : (
										<p className="text-muted-foreground">
											Previews are limited; sensitive fields and large content are omitted.
										</p>
									)}
								</div>
							</details>
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
				))}
			</ul>
		</section>
	);
}

function ToolPreview({ label, value }: { label: string; value?: string }) {
	if (!value) return null;
	return (
		<div>
			<p className="mb-1 font-medium">{label}</p>
			<pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px]">
				{value}
			</pre>
		</div>
	);
}

export function ChatProgress({ calls }: { calls: readonly ToolActivityEntry[] }) {
	const running = calls.filter((call) => call.status === 'running').at(-1);
	const waitingForConsent = running?.permission?.status === 'open';
	let message = calls.length > 0 ? 'Preparing a response…' : 'Planning the next step…';
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
