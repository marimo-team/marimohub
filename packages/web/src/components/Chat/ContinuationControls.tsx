import { useState } from 'react';
import type { ConversationContinuation } from '@/api/conversations';
import { Button, ConfirmDialog } from '@/components/ui';

const REASONS: Record<NonNullable<ConversationContinuation['reason']>, string> = {
	tool_limit: 'The reply reached its tool-call budget.',
	context_limit: 'The reply reached its context limit.',
	interrupted: 'The reply was interrupted before it finished.',
	stopped: 'You stopped the reply.',
	failed: 'The reply failed.',
};

export function ContinuationControls({
	continuation,
	busy,
	onResume,
	onDismiss,
}: {
	continuation: ConversationContinuation | undefined;
	busy: boolean;
	onResume: (acknowledgeUncertain: boolean) => Promise<boolean>;
	onDismiss?: () => Promise<unknown>;
}) {
	const [reviewOpen, setReviewOpen] = useState(false);
	if (!continuation || continuation.status === 'running') return null;
	const needsReview = continuation.status === 'needs_review';
	return (
		<aside aria-label="Saved task" className="rounded-lg border bg-background p-3 text-sm">
			<p className="font-medium">{needsReview ? 'Review the interrupted task' : 'Task paused'}</p>
			<p className="mt-1 text-muted-foreground">
				{continuation.reason ? `${REASONS[continuation.reason]} ` : ''}
				{needsReview
					? 'An operation may have partially completed. You can keep chatting and request new work. Check its outcome before retrying the interrupted task.'
					: 'Completed steps are saved. Continue the task with your current project permissions.'}
			</p>
			<div className="mt-3 flex flex-wrap gap-2">
				<Button
					size="sm"
					isDisabled={busy}
					onPress={() => {
						if (needsReview) setReviewOpen(true);
						else void onResume(false);
					}}
				>
					{needsReview ? 'Review and continue' : 'Continue task'}
				</Button>
				{onDismiss ? (
					<Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void onDismiss()}>
						Dismiss task
					</Button>
				) : null}
			</div>
			<ConfirmDialog
				isOpen={reviewOpen && !busy}
				onClose={() => setReviewOpen(false)}
				title="Continue an interrupted task"
				description="The previous operation may have completed. Continuing starts from saved observations; it does not replay the interrupted call automatically. Check its outcome first to avoid duplicate changes."
				confirmLabel="I checked the outcome — continue"
				variant="primary"
				isPending={busy}
				onConfirm={() => {
					setReviewOpen(false);
					void onResume(true);
				}}
			>
				{continuation.unresolved_calls.length > 0 ? (
					<ul className="list-inside list-disc text-sm">
						{continuation.unresolved_calls.map((call) => (
							<li key={call.id}>{call.name.replaceAll('_', ' ')}</li>
						))}
					</ul>
				) : null}
			</ConfirmDialog>
		</aside>
	);
}
