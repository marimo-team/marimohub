import { useRef, useState } from 'react';
import { Clock3, ShieldCheck, ShieldX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationPermission, PermissionDecision } from '@/api/conversations';
import { Button } from '@/components/ui';

export type DecidePermission = (
	rid: string,
	decision: PermissionDecision,
) => Promise<{ accepted: boolean }>;

function outcome(permission: ConversationPermission) {
	switch (permission.status) {
		case 'allowed':
			return 'Allowed once';
		case 'remembered':
			return `Always allowed for ${permission.scope.label}`;
		case 'denied':
			return 'Not allowed';
		case 'expired':
			return 'No answer in time. Chat continued without it.';
		case 'cancelled':
			return 'Stopped';
		case 'unavailable':
			return 'This client cannot ask for permission.';
		case 'open':
			return '';
	}
}

export function PermissionCard({
	permission,
	onDecide,
}: {
	permission: ConversationPermission;
	onDecide?: DecidePermission;
}) {
	const sending = useRef(false);
	const [pending, setPending] = useState(false);
	const [closed, setClosed] = useState(false);
	const [error, setError] = useState('');
	const decide = async (decision: PermissionDecision) => {
		if (sending.current || !onDecide) return;
		sending.current = true;
		setPending(true);
		setError('');
		try {
			const result = await onDecide(permission.id, decision);
			if (!result.accepted) {
				setClosed(true);
				setPending(false);
			}
		} catch {
			sending.current = false;
			setPending(false);
			setError('The decision could not be sent. Please retry.');
		}
	};
	const allowed = permission.status === 'allowed' || permission.status === 'remembered';
	const denied = permission.status === 'denied';
	const OutcomeIcon = allowed ? ShieldCheck : denied ? ShieldX : Clock3;
	const open = permission.status === 'open' && !closed;
	const outcomeBadge = (
		<output
			className={cn(
				'inline-flex max-w-full items-start gap-1.5 rounded-md border px-2 py-1 text-xs font-medium',
				allowed
					? 'border-emerald-600/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
					: denied
						? 'border-destructive/20 bg-destructive/10 text-destructive'
						: 'border-border bg-muted text-muted-foreground',
			)}
		>
			<OutcomeIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
			<span className="min-w-0 break-words">
				{closed && permission.status === 'open'
					? 'This permission request is closed.'
					: outcome(permission)}
			</span>
		</output>
	);
	// A settled request is history: one quiet line. An open one needs attention.
	if (!open)
		return (
			<section
				aria-label="Tool permission"
				className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
			>
				<span className="font-medium text-foreground">{permission.action}</span>
				{permission.details.map((detail) => (
					<span key={`${detail.label}:${detail.value}`} className="truncate">
						{detail.label}: {detail.value}
					</span>
				))}
				{outcomeBadge}
			</section>
		);
	return (
		<section
			aria-label="Tool permission"
			className="mt-3 space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-4 text-sm"
		>
			<p className="font-medium">{permission.action}</p>
			{permission.details.length > 0 ? (
				<dl className="space-y-1">
					{permission.details.map((detail) => (
						<div key={`${detail.label}:${detail.value}`} className="flex gap-2 break-all">
							<dt className="text-muted-foreground">{detail.label}:</dt>
							<dd className="whitespace-pre-wrap">{detail.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="primary"
					isDisabled={pending || !onDecide}
					onPress={() => void decide('allow')}
				>
					Allow once
				</Button>
				{permission.can_remember ? (
					<Button isDisabled={pending || !onDecide} onPress={() => void decide('always')}>
						Always allow {permission.scope.label}
					</Button>
				) : null}
				<Button isDisabled={pending || !onDecide} onPress={() => void decide('deny')}>
					Do not allow
				</Button>
			</div>
			{pending && <output>Sending…</output>}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
		</section>
	);
}
