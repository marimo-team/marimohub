import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, Copy, Plus, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, DialogModal, IconButton, TextField } from '@/components/ui';
import { useApiTokensQuery, useCreateApiToken, useRevokeApiToken } from '@/api/hooks';
import { formatRelative } from '@/lib/time';
import type { ApiToken, ApiTokenCreated } from '@/types';

export interface ApiTokensDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

function CopyTokenField({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error('Could not copy to clipboard');
		}
	};

	return (
		<div className="flex items-center gap-2">
			<input
				readOnly
				aria-label="API token"
				value={value}
				onFocus={(e) => e.target.select()}
				className="h-9 w-full rounded-md border border-input bg-muted/40 px-3 font-mono text-xs text-foreground outline-none"
			/>
			<IconButton label={copied ? 'Copied' : 'Copy token'} onPress={() => void copy()}>
				{copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
			</IconButton>
		</div>
	);
}

/** "expires <in 30 days>" / "expired <3 days ago>" from the ISO deadline. */
function expiryLabel(iso: string): string {
	return `${iso <= new Date().toISOString() ? 'expired' : 'expires'} ${formatRelative(iso)}`;
}

/**
 * Self-service personal access tokens for the API (CI, scripts, the CLI). The
 * plaintext is server-side hashed, so it is shown exactly once, right after
 * creation — the list only ever carries metadata.
 */
export function ApiTokensDialog({ isOpen, onClose }: ApiTokensDialogProps) {
	const { data: tokens } = useApiTokensQuery(isOpen);
	const createToken = useCreateApiToken();
	const revokeToken = useRevokeApiToken();

	const [name, setName] = useState('');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [created, setCreated] = useState<ApiTokenCreated | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

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
		try {
			const result = await createToken.mutateAsync({
				name: trimmed,
				...(days ? { expires_in_days: Number(days) } : {}),
			});
			setCreated(result);
			setName('');
			setExpiresInDays('');
		} catch (err) {
			toast.error((err as Error).message);
		}
	};

	const handleRevoke = () => {
		if (!revokeTarget) return;
		revokeToken.mutate(revokeTarget.id, {
			onSuccess: () => {
				toast.success('Token revoked');
				setRevokeTarget(null);
			},
			onError: (err) => toast.error(err.message),
		});
	};

	const close = () => {
		setCreated(null);
		onClose();
	};

	return (
		<DialogModal isOpen={isOpen} onClose={close} title="API tokens" width="md">
			<div className="flex flex-col gap-4 text-sm">
				<p className="text-muted-foreground">
					Personal access tokens let CI, scripts, and the CLI call the API as you: send one as{' '}
					<code className="text-xs">Authorization: Bearer …</code>. Tokens cannot manage other
					tokens.
				</p>

				{created && (
					<div className="flex flex-col gap-2 rounded-md border p-3">
						<span className="text-xs font-semibold">{created.name}</span>
						<CopyTokenField value={created.token} />
						<div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
							<AlertTriangle className="mt-px size-4 shrink-0" />
							<span>Copy this token now — it is shown once and cannot be retrieved later.</span>
						</div>
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
										onPress={() => setRevokeTarget(token)}
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
					<div className="flex justify-end">
						<Button type="submit" variant="primary" isDisabled={createToken.isPending}>
							<Plus className="size-4" />
							{createToken.isPending ? 'Creating...' : 'Create token'}
						</Button>
					</div>
				</form>

				<ConfirmDialog
					isOpen={!!revokeTarget}
					onClose={() => setRevokeTarget(null)}
					title="Revoke token"
					description={`Revoke "${revokeTarget?.name}"? Anything still using it will stop authenticating within about a minute.`}
					confirmLabel="Revoke"
					pendingLabel="Revoking..."
					isPending={revokeToken.isPending}
					onConfirm={handleRevoke}
				/>
			</div>
		</DialogModal>
	);
}
