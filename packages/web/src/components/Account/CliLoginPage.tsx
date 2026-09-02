import { useState } from 'react';
import { ArrowRight, Check, Clock3, ShieldCheck, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { useApproveCliAuthorization, useApproveScopedCliAuthorization } from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';
import { Brand, Button, TextField } from '@/components/ui';
import { cancellationUrl, parseCliLoginRequest } from './cliLoginRequest';
import { TokenGrantEditor } from './TokenGrantEditor';
import { tokenGrantFromDraft } from './tokenGrantDraft';
import type { TokenGrantDraft } from './tokenGrantDraft';

export interface CliLoginPageProps {
	navigate?: (url: string) => void;
}

export function CliLoginPage({
	navigate = (url) => window.location.assign(url),
}: CliLoginPageProps) {
	const request = parseCliLoginRequest(window.location.search);
	const { user } = useAuth();
	const approve = useApproveCliAuthorization();
	const approveScoped = useApproveScopedCliAuthorization();
	const [expiresInDays, setExpiresInDays] = useState('30');
	const [grantDraft, setGrantDraft] = useState<TokenGrantDraft>(() => ({
		actions: request?.requestedGrant?.actions ?? null,
		projects: request?.requestedGrant?.projects ?? null,
	}));
	const grant = tokenGrantFromDraft(grantDraft);
	const isPending = approve.isPending || approveScoped.isPending;

	if (!request) {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/30 p-6">
				<title>Invalid CLI request · marimohub</title>
				<Brand size="lg" />
				<div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-8 text-center shadow-md">
					<Terminal className="size-8 text-muted-foreground" />
					<h1 className="text-lg font-semibold">Invalid CLI login request</h1>
					<p className="text-sm text-muted-foreground">
						Return to your terminal and run <code>mohub login</code> again.
					</p>
				</div>
			</div>
		);
	}

	const submit = async () => {
		const days = Number(expiresInDays);
		if (!/^\d+$/.test(expiresInDays) || !Number.isInteger(days) || days < 1 || days > 3650) {
			toast.error('Choose a token lifetime between 1 and 3650 days.');
			return;
		}
		try {
			if (request.requestedGrant && !grant) return;
			const common = {
				callback_uri: request.callback.toString(),
				state: request.state,
				code_challenge: request.codeChallenge,
				token_name: 'mohub CLI',
				expires_in_days: days,
			};
			const result = request.requestedGrant
				? await approveScoped.mutateAsync({
						...common,
						requested_grant: request.requestedGrant,
						grant: grant!,
					})
				: await approve.mutateAsync(common);
			navigate(result.redirect_uri);
		} catch {
			return;
		}
	};

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/30 p-6">
			<title>Connect the mohub CLI · marimohub</title>
			<Brand size="lg" />

			<div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-lg">
				<div className="flex flex-col items-center gap-3 border-b px-8 py-7 text-center">
					<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
						<Terminal className="size-6" />
					</div>

					{request.requestedGrant ? (
						<TokenGrantEditor
							value={grantDraft}
							onChange={setGrantDraft}
							upperBound={request.requestedGrant}
						/>
					) : null}
					<div className="flex flex-col gap-1">
						<h1 className="text-xl font-semibold">Connect the mohub CLI</h1>
						<p className="text-sm text-muted-foreground">
							Authorize the CLI on this computer to access {window.location.host} as{' '}
							<span className="font-medium text-foreground">{user?.email ?? user?.id}</span>.
						</p>
					</div>
				</div>

				<form
					className="flex flex-col gap-5 px-8 py-6"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
						<ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
						<div className="flex flex-col gap-2 text-sm">
							<span className="font-medium">What you’re approving</span>
							<ul className="flex flex-col gap-1.5 text-muted-foreground">
								<li className="flex items-start gap-2">
									<Check className="mt-0.5 size-3.5 shrink-0" />
									The CLI will act with your current account permissions.
								</li>
								<li className="flex items-start gap-2">
									<Check className="mt-0.5 size-3.5 shrink-0" />
									The credential returns only to the local CLI callback.
								</li>
								<li className="flex items-start gap-2">
									<Check className="mt-0.5 size-3.5 shrink-0" />
									You can revoke it any time from API tokens.
								</li>
							</ul>
						</div>
					</div>

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
							{['7', '30', '90'].map((days) => (
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
						<Button
							type="button"
							isDisabled={isPending}
							onPress={() => navigate(cancellationUrl(request))}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="primary"
							isDisabled={isPending || (request.requestedGrant !== undefined && grant === null)}
						>
							{isPending ? 'Connecting…' : 'Authorize CLI'}
							{isPending ? null : <ArrowRight className="size-4" />}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
