import { useState } from 'react';
import { ArrowRight, Clock3, ShieldAlert } from 'lucide-react';
import { TOKEN_GRANT_PRESETS } from '@marimo-hub/core/token-grants';
import { toast } from 'sonner';
import {
	useApproveOAuthAuthorization,
	useDenyOAuthAuthorization,
	useOAuthAuthorizationPreview,
} from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';
import { Brand, Button, TextField } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { TokenGrantEditor } from './TokenGrantEditor';
import { tokenGrantFromDraft } from './tokenGrantDraft';
import type { TokenGrantDraft } from './tokenGrantDraft';

const TOKEN_LIFETIME_PRESETS = ['7', '30', '90'] as const;

export interface OAuthConsentPageProps {
	navigate?: (url: string) => void;
}

export function OAuthConsentPage({
	navigate = (url) => window.location.assign(url),
}: OAuthConsentPageProps) {
	const id = new URLSearchParams(window.location.search).get('id');
	const { user } = useAuth();
	const preview = useOAuthAuthorizationPreview(id);
	const approve = useApproveOAuthAuthorization();
	const deny = useDenyOAuthAuthorization();
	const [expiresInDays, setExpiresInDays] = useState('30');
	const [grantDraft, setGrantDraft] = useState<TokenGrantDraft>({
		actions: [...TOKEN_GRANT_PRESETS.edit],
		projects: '*',
	});
	const grant = tokenGrantFromDraft(grantDraft);
	const pending = approve.isPending || deny.isPending;

	const approveConnection = async () => {
		if (!id || !preview.data || !grant) return;
		const days = Number(expiresInDays);
		if (!/^\d+$/.test(expiresInDays) || days < 1 || days > 3650) {
			toast.error('Choose a token lifetime between 1 and 3650 days.');
			return;
		}
		try {
			const response = await approve.mutateAsync({
				id,
				grant,
				expires_in_days: days,
			});
			navigate(response.redirect_uri);
		} catch {
			return;
		}
	};

	const denyConnection = async () => {
		if (!id) return;
		try {
			const response = await deny.mutateAsync(id);
			navigate(response.redirect_uri);
		} catch {
			return;
		}
	};

	let redirectHost = '';
	try {
		redirectHost = preview.data ? new URL(preview.data.redirect_uri).host : '';
	} catch {
		redirectHost = preview.data?.redirect_uri ?? '';
	}

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/30 p-6">
			<title>Connect an MCP client · marimohub</title>
			<Brand size="lg" />
			<div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-lg">
				<div className="flex flex-col gap-2 border-b px-8 py-7 text-center">
					<h1 className="text-xl font-semibold">Connect an MCP client</h1>
					<p className="text-sm text-muted-foreground">
						Authorize {preview.data?.client_name ?? 'this client'} to access marimohub as{' '}
						<span className="font-medium text-foreground">{user?.email ?? user?.id}</span>.
					</p>
				</div>
				{!id || preview.isError ? (
					<div className="flex flex-col gap-3 p-8 text-center" role="alert">
						<p className="font-medium">This authorization request is invalid or expired.</p>
						{preview.error ? (
							<p className="text-sm text-destructive">{errorMessage(preview.error)}</p>
						) : null}
					</div>
				) : preview.isPending ? (
					<div className="p-8 text-center text-sm text-muted-foreground">Loading request…</div>
				) : (
					<form
						className="flex flex-col gap-5 px-8 py-6"
						onSubmit={(event) => {
							event.preventDefault();
							void approveConnection();
						}}
					>
						<div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
							<ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
							<div className="flex flex-col gap-1 text-sm">
								<span className="font-medium">Verify the client and redirect</span>
								<p className="text-muted-foreground">
									Approve only if you started this connection. The credential will return to{' '}
									<strong>{redirectHost}</strong> and lets the client act with the grant below.
								</p>
							</div>
						</div>
						<TokenGrantEditor value={grantDraft} onChange={setGrantDraft} />
						<div className="flex items-end gap-3">
							<Clock3 className="mb-2 size-5 shrink-0 text-muted-foreground" />
							<TextField
								className="flex-1"
								label="Token lifetime (days)"
								value={expiresInDays}
								onChange={setExpiresInDays}
								inputMode="numeric"
							/>
							<div className="mb-1 flex gap-1">
								{TOKEN_LIFETIME_PRESETS.map((days) => (
									<Button
										key={days}
										type="button"
										size="sm"
										variant={expiresInDays === days ? 'primary' : 'default'}
										onPress={() => setExpiresInDays(days)}
									>
										{days}d
									</Button>
								))}
							</div>
						</div>
						<div className="flex justify-end gap-2 border-t pt-5">
							<Button type="button" isDisabled={pending} onPress={() => void denyConnection()}>
								Deny
							</Button>
							<Button type="submit" variant="primary" isDisabled={pending || !grant}>
								{approve.isPending ? 'Connecting…' : 'Approve'}
								{approve.isPending ? null : <ArrowRight className="size-4" />}
							</Button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
