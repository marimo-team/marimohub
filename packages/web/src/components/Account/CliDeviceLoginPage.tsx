import { useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, ShieldAlert, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import {
	useApproveCliDeviceAuthorization,
	useApproveScopedCliDeviceAuthorization,
	useCliDeviceAuthorizationPreview,
} from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';
import { Brand, Button, TextField } from '@/components/ui';
import { withBasePath } from '@/lib/basePath';
import { errorMessage } from '@/lib/errors';
import { TokenGrantEditor } from './TokenGrantEditor';
import { tokenGrantFromDraft } from './tokenGrantDraft';
import type { TokenGrantDraft } from './tokenGrantDraft';

const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const TOKEN_LIFETIME_PRESETS = ['7', '30', '90'] as const;

function normalizeUserCode(value: string): string | null {
	const normalized = value.toUpperCase().replaceAll(/[\s-]/g, '');
	return USER_CODE_RE.test(normalized) ? normalized : null;
}

function formatUserCode(value: string): string {
	return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function parseTokenLifetime(value: string): number | null {
	const days = Number(value);
	return /^\d+$/.test(value) && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null;
}

export interface CliDeviceLoginPageProps {
	navigate?: (url: string) => void;
}

export function CliDeviceLoginPage({
	navigate = (url) => window.location.assign(url),
}: CliDeviceLoginPageProps) {
	const initialCode = new URLSearchParams(window.location.search).get('user_code') ?? '';
	const { user } = useAuth();
	const approve = useApproveCliDeviceAuthorization();
	const approveScoped = useApproveScopedCliDeviceAuthorization();
	const [userCode, setUserCode] = useState(initialCode);
	const [expiresInDays, setExpiresInDays] = useState('30');
	const [approved, setApproved] = useState(false);
	const normalizedCode = normalizeUserCode(userCode);
	const preview = useCliDeviceAuthorizationPreview(
		normalizedCode ? formatUserCode(normalizedCode) : null,
	);
	const [grantOverride, setGrantOverride] = useState<{
		code: string;
		draft: TokenGrantDraft;
	} | null>(null);
	const requestedDraft: TokenGrantDraft | null =
		preview.data?.status === 'scoped'
			? {
					actions: preview.data.requested_grant.actions,
					projects: preview.data.requested_grant.projects,
				}
			: null;
	const grantDraft =
		normalizedCode && grantOverride?.code === normalizedCode ? grantOverride.draft : requestedDraft;
	const grant = grantDraft ? tokenGrantFromDraft(grantDraft) : null;
	const isPending = approve.isPending || approveScoped.isPending;
	const approvalError = preview.data?.status === 'scoped' ? approveScoped.error : approve.error;
	const resetApprovalErrors = () => {
		approve.reset();
		approveScoped.reset();
	};
	const updateGrantDraft = (draft: TokenGrantDraft) => {
		if (normalizedCode) {
			approveScoped.reset();
			setGrantOverride({ code: normalizedCode, draft });
		}
	};

	const submit = async () => {
		const code = normalizeUserCode(userCode);
		if (!code) {
			toast.error('Enter the 8-letter code shown by the mohub CLI.');
			return;
		}
		const days = parseTokenLifetime(expiresInDays);
		if (days === null) {
			toast.error('Choose a token lifetime between 1 and 3650 days.');
			return;
		}
		try {
			if (!preview.data) return;
			const common = {
				user_code: formatUserCode(code),
				token_name: 'mohub CLI',
				expires_in_days: days,
			};
			if (preview.data.status === 'scoped') {
				if (!grant) return;
				await approveScoped.mutateAsync({ ...common, grant });
			} else {
				await approve.mutateAsync(common);
			}
			setUserCode(formatUserCode(code));
			setApproved(true);
		} catch {
			return;
		}
	};

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/30 p-6">
			<title>
				{approved ? 'CLI connected · marimohub' : 'Connect a remote mohub CLI · marimohub'}
			</title>
			<Brand size="lg" />
			{approved ? (
				<div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center shadow-md">
					<CheckCircle2 className="size-10 text-primary" />
					<h1 className="text-xl font-semibold">CLI authorization approved</h1>
					<p className="text-sm text-muted-foreground">
						Return to the terminal that displays <strong>{userCode}</strong>. You can close this
						tab.
					</p>
				</div>
			) : (
				<div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-lg">
					<div className="flex flex-col items-center gap-3 border-b px-8 py-7 text-center">
						<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
							<Terminal className="size-6" />
						</div>

						{preview.isError ? (
							<div
								role="alert"
								className="flex w-full flex-col gap-2 rounded-md border p-3 text-left"
							>
								<p className="text-sm font-medium">Could not load this CLI authorization</p>
								<p className="text-xs text-destructive">{errorMessage(preview.error)}</p>
								<Button
									size="sm"
									onPress={() => {
										resetApprovalErrors();
										void preview.refetch();
									}}
								>
									Retry preview
								</Button>
							</div>
						) : preview.data?.status === 'scoped' && grantDraft ? (
							<TokenGrantEditor
								value={grantDraft}
								onChange={updateGrantDraft}
								upperBound={preview.data.requested_grant}
							/>
						) : null}
						<div className="flex flex-col gap-1">
							<h1 className="text-xl font-semibold">Connect a remote mohub CLI</h1>
							<p className="text-sm text-muted-foreground">
								Authorize a CLI to access {window.location.host} as{' '}
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
						<TextField
							label="Device code"
							value={userCode}
							onChange={(value) => {
								resetApprovalErrors();
								setUserCode(value);
							}}
							placeholder="WDJB-MJHT"
							autoComplete="one-time-code"
						/>

						<div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
							<ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
							<div className="flex flex-col gap-1 text-sm">
								<span className="font-medium">Verify the code in your terminal</span>
								<p className="text-muted-foreground">
									Approve only if you started this login and the same code is currently displayed by
									your mohub CLI. A code sent by another person can grant that person access as you.
								</p>
							</div>
						</div>

						<div className="flex items-end gap-3">
							<Clock3 className="mb-2 size-5 shrink-0 text-muted-foreground" />
							<TextField
								className="flex-1"
								label="Token lifetime (days)"
								value={expiresInDays}
								onChange={(value) => {
									resetApprovalErrors();
									setExpiresInDays(value);
								}}
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

						{approvalError ? (
							<div role="alert" className="rounded-md border p-3 text-sm text-destructive">
								{errorMessage(approvalError)}
							</div>
						) : null}

						<div className="flex justify-end gap-2 border-t pt-5">
							<Button
								type="button"
								isDisabled={isPending}
								onPress={() => navigate(withBasePath('/'))}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="primary"
								isDisabled={
									isPending ||
									(normalizedCode !== null &&
										(preview.isFetching ||
											preview.isError ||
											preview.data === undefined ||
											(preview.data.status === 'scoped' && grant === null)))
								}
							>
								{isPending ? 'Connecting…' : 'Authorize CLI'}
								{isPending ? null : <ArrowRight className="size-4" />}
							</Button>
						</div>
					</form>
				</div>
			)}
		</div>
	);
}
