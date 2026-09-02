import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import {
	Button,
	ConfirmDialog,
	CopyField,
	DialogModal,
	IconButton,
	TextField,
	WriteOnceWarning,
} from '@/components/ui';
import { useApiTokensQuery, useCreateScopedApiToken, useRevokeApiToken } from '@/api/hooks';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { formatDuration, formatRelative } from '@/lib/time';
import type { ApiToken, ApiTokenCreated } from '@/types';
import { TokenGrantEditor, tokenGrantFromDraft } from './TokenGrantEditor';
import type { TokenGrantDraft } from './TokenGrantEditor';
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
	const preset = Object.entries(TOKEN_GRANT_PRESETS).find(([, actions]) => {
		if (actions === '*' || grant.actions === '*') return actions === grant.actions;
		return (
			actions.length === grant.actions.length &&
			actions.every((action) => grant.actions.includes(action))
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

/**
 * Self-service personal access tokens for the API (CI, scripts, the CLI). The
 * plaintext is server-side hashed, so it is shown exactly once, right after
 * creation — the list only ever carries metadata.
 */
export function ApiTokensDialog({ isOpen, onClose }: ApiTokensDialogProps) {
	const { data: tokens } = useApiTokensQuery(isOpen);
	const createToken = useCreateScopedApiToken();
	const revokeToken = useRevokeApiToken();

	const [name, setName] = useState('');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [created, setCreated] = useState<ApiTokenCreated | null>(null);
	const [grantDraft, setGrantDraft] = useState<TokenGrantDraft>({
		actions: null,
		projects: null,
	});
	const confirmRevoke = useDialogTarget<ApiToken>();

	const handleCreate = async () => {
		const trimmed = name.trim();
		if (!trimmed) {
			toast.error('Name the token (e.g. "ci-deploy") so you can recognize it later.');
			return;
		}
		const days = expiresInDays.trim();
		if (days && !/^\d+$/.test(days)) {
			toast.error('Expiry must be a whole number of days.');
			return;
		}
		const grant = tokenGrantFromDraft(grantDraft);
		if (!grant) {
			toast.error('Choose an action preset and a project scope.');
			return;
		}
		try {
			const result = await createToken.mutateAsync({
				name: trimmed,
				...(days ? { expires_in_days: Number(days) } : {}),
				grant,
			});
			setCreated(result);
			setName('');
			setExpiresInDays('');
			setGrantDraft({ actions: null, projects: null });
		} catch {
			return;
		}
	};

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

				<form
					onSubmit={(e) => {
						e.preventDefault();
						void handleCreate();
					}}
					className="flex flex-col gap-3 border-t pt-4"
				>
					<span className="text-xs font-semibold">Create a token</span>
					<div className="flex gap-2">
						<div className="flex-1">
							<TextField label="Name" placeholder="ci-deploy" value={name} onChange={setName} />
						</div>
						<div className="w-36 shrink-0">
							<TextField
								label="Expires in days"
								placeholder="never"
								value={expiresInDays}
								onChange={setExpiresInDays}
							/>
						</div>
					</div>
					<TokenGrantEditor value={grantDraft} onChange={setGrantDraft} />
					<div className="flex justify-end">
						<Button
							type="submit"
							variant="primary"
							isDisabled={createToken.isPending || tokenGrantFromDraft(grantDraft) === null}
						>
							<Plus className="size-4" />
							{createToken.isPending ? 'Creating...' : 'Create token'}
						</Button>
					</div>
				</form>

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
