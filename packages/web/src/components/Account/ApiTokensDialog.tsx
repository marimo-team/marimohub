import { useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import {
	ConfirmDialog,
	CopyField,
	DialogModal,
	IconButton,
	WriteOnceWarning,
} from '@/components/ui';
import { useApiTokensQuery, useRevokeApiToken } from '@/api/hooks';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { formatDuration, formatRelative } from '@/lib/time';
import type { ApiToken, ApiTokenCreated } from '@/types';
import { CreateTokenForm } from './CreateTokenForm';
import { TOKEN_GRANT_PRESETS } from '@marimo-hub/core/token-grants';

export interface ApiTokensDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

/**
 * "expires in 30d" / "expired 3d ago" from the ISO deadline. A future deadline
 * needs the remaining span (`formatRelative` flattens all future times to "just
 * now"); a past one reads naturally as a relative phrase.
 */
function expiryLabel(iso: string, now: number = Date.now()): string {
	const deadline = new Date(iso).getTime();
	if (Number.isNaN(deadline)) return '';
	if (deadline <= now) return `expired ${formatRelative(iso, now)}`;
	return `expires in ${formatDuration(new Date(now).toISOString(), deadline)}`;
}

function grantLabel(token: ApiToken): string {
	if (!token.grant) return 'Full access · all projects · legacy';
	const grant = token.grant;
	const grantedActions = grant.actions === '*' ? null : new Set(grant.actions);
	const preset = Object.entries(TOKEN_GRANT_PRESETS).find(([, actions]) => {
		if (actions === '*' || grant.actions === '*') return actions === grant.actions;
		return (
			actions.length === grant.actions.length &&
			actions.every((action) => grantedActions?.has(action))
		);
	});
	const actions = preset
		? `${preset[0][0].toUpperCase()}${preset[0].slice(1)} access`
		: 'Custom access';
	const projects =
		grant.projects === '*'
			? 'all projects'
			: `${grant.projects.length} selected project${grant.projects.length === 1 ? '' : 's'}`;
	return `${actions} · ${projects}`;
}

export function ApiTokensDialog({ isOpen, onClose }: ApiTokensDialogProps) {
	const { data: tokens } = useApiTokensQuery(isOpen);
	const revokeToken = useRevokeApiToken();

	const [created, setCreated] = useState<ApiTokenCreated | null>(null);
	const confirmRevoke = useDialogTarget<ApiToken>();

	const handleRevoke = () => {
		const target = confirmRevoke.target;
		if (!target) return;
		revokeToken.mutate(target.id, {
			onSuccess: () => {
				toast.success('Token revoked');
				confirmRevoke.close();
			},
		});
	};

	const close = () => {
		setCreated(null);
		onClose();
	};

	return (
		<DialogModal isOpen={isOpen} onClose={close} title="API tokens" width="lg">
			<div className="flex flex-col gap-4 text-sm">
				<p className="text-muted-foreground">
					Personal access tokens let CI, scripts, and the CLI call the API as you: send one as{' '}
					<code className="text-xs">Authorization: Bearer …</code>. Tokens cannot manage other
					tokens.
				</p>

				{created && (
					<div className="flex flex-col gap-2 rounded-md border p-3">
						<span className="text-xs font-semibold">{created.name}</span>
						<CopyField label="API token" value={created.token} copyLabel="Copy token" hideLabel />
						<WriteOnceWarning />
					</div>
				)}

				{tokens &&
					(tokens.length === 0 ? (
						!created && <p className="text-muted-foreground">No tokens yet.</p>
					) : (
						<ul className="flex flex-col divide-y">
							{tokens.map((token) => (
								<li
									key={token.id}
									data-testid="token-row"
									className="flex items-center justify-between gap-3 py-2"
								>
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-xs font-medium">{token.name}</span>
										<span className="truncate text-xs text-muted-foreground">
											{token.mcp_resource ? 'MCP · ' : ''}
											{grantLabel(token)}
										</span>
										<span className="truncate text-xs text-muted-foreground">
											created {formatRelative(token.created_at)}
											{token.expires_at ? ` · ${expiryLabel(token.expires_at)}` : ''}
											{token.last_used_at
												? ` · last used ${formatRelative(token.last_used_at)}`
												: ' · never used'}
										</span>
									</span>
									<IconButton
										label={`Revoke ${token.name}`}
										tooltip="Revoke token"
										tone="danger"
										onPress={() => confirmRevoke.open(token)}
									>
										<Trash2 className="size-4" />
									</IconButton>
								</li>
							))}
						</ul>
					))}

				<div className="flex flex-col gap-3 border-t pt-4">
					<span className="text-xs font-semibold">Create a token</span>
					<CreateTokenForm kind="api" onCreated={setCreated} />
				</div>

				<ConfirmDialog
					isOpen={confirmRevoke.isOpen}
					onClose={confirmRevoke.close}
					title="Revoke token"
					description={`Revoke "${confirmRevoke.target?.name}"? Anything still using it will stop authenticating within about a minute.`}
					confirmLabel="Revoke"
					pendingLabel="Revoking..."
					isPending={revokeToken.isPending}
					onConfirm={handleRevoke}
				/>
			</div>
		</DialogModal>
	);
}
