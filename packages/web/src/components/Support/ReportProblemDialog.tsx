import { useRef, useState } from 'react';
import { SUPPORT_LIMITS } from '@marimo-hub/core/support';
import type { SupportContext, SupportDiagnostics } from './diagnostics';
import { apiClient, apiData } from '@/api/client';
import { capabilitiesQueryOptions } from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
import { useBranding } from '@/context/BrandingContext';
import { Button } from '@/components/ui/Button';
import { DialogModal } from '@/components/ui/Dialog';
import { copyText } from '@/lib/clipboard';
import { clientSupportContext } from './diagnostics';

interface ReportContext {
	session?: SupportContext['session'];
	error?: string;
}

interface ReportState {
	context: SupportContext;
	diagnostics: SupportDiagnostics | SupportContext;
	reports: boolean;
	loading: boolean;
	error?: string;
}

export function useProblemReport(context: ReportContext = {}) {
	const [report, setReport] = useState<ReportState | null>(null);
	const generation = useRef(0);
	const close = () => {
		generation.current++;
		setReport(null);
	};
	const open = async () => {
		const current = ++generation.current;
		const input = clientSupportContext(context.session, context.error);
		setReport({ context: input, diagnostics: input, reports: false, loading: true });
		// The module client, not useQueryClient: error boundaries render this outside providers.
		const [diagnostics, capabilities] = await Promise.allSettled([
			apiData(apiClient.POST('/api/v1/support/diagnostics', { body: input })),
			queryClient.fetchQuery(capabilitiesQueryOptions()),
		]);
		if (current !== generation.current) return;
		setReport({
			context: input,
			diagnostics: diagnostics.status === 'fulfilled' ? diagnostics.value : input,
			reports:
				diagnostics.status === 'fulfilled' &&
				capabilities.status === 'fulfilled' &&
				capabilities.value.support.reports,
			loading: false,
			...(diagnostics.status === 'rejected' || capabilities.status === 'rejected'
				? {
						error:
							'Support details could not be loaded. You can still copy the available diagnostics.',
					}
				: {}),
		});
	};
	return {
		open,
		dialog: report ? <ReportProblemDialog report={report} onClose={close} /> : null,
	};
}

function ReportProblemDialog({ report, onClose }: { report: ReportState; onClose: () => void }) {
	const { support_url } = useBranding();
	const [message, setMessage] = useState('');
	const [delivery, setDelivery] = useState<'idle' | 'sending' | 'sent'>('idle');
	const [status, setStatus] = useState('');
	const [error, setError] = useState('');
	const trimmedMessage = message.trim();
	const payload = JSON.stringify({ ...report.diagnostics, message: trimmedMessage }, null, 2);
	const send = async () => {
		setDelivery('sending');
		setError('');
		try {
			const result = await apiData(
				apiClient.POST('/api/v1/support/requests', {
					body: { ...report.context, message: trimmedMessage },
				}),
			);
			setDelivery('sent');
			setStatus(
				result.delivery === 'partial'
					? 'Report sent. Some support destinations could not be reached.'
					: 'Report sent.',
			);
		} catch (cause) {
			setDelivery('idle');
			setError(cause instanceof Error ? cause.message : 'Could not send report. Please try again.');
		}
	};
	return (
		<DialogModal
			isOpen
			onClose={onClose}
			isDismissable={delivery !== 'sending'}
			title="Report a problem"
			width="lg"
		>
			<div className="flex flex-col gap-4">
				<label className="flex flex-col gap-2 text-sm">
					What happened?
					<textarea
						aria-label="What happened?"
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						maxLength={SUPPORT_LIMITS.message}
						rows={3}
						disabled={delivery !== 'idle'}
						className="w-full rounded-md border bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
				</label>
				<p className="text-xs text-muted-foreground">
					Review the diagnostics before sharing. Do not include passwords or private notebook data
					in your message.
				</p>
				<label className="flex flex-col gap-2 text-sm">
					Diagnostics
					<textarea
						aria-label="Diagnostics"
						readOnly
						value={payload}
						rows={10}
						className="w-full rounded-md border bg-muted p-2 font-mono text-xs"
					/>
				</label>
				{report.loading && <output className="text-sm">Loading diagnostics…</output>}
				{(error || report.error) && (
					<p role="alert" className="text-sm text-destructive">
						{error || report.error}
					</p>
				)}
				{status && <output className="text-sm">{status}</output>}
				{!report.loading && !report.reports && !report.error && (
					<p className="text-sm text-muted-foreground">
						Copy diagnostics and share them with your administrator.
					</p>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						onPress={() => {
							void copyText(payload).then((copied) => {
								if (copied) setStatus('Diagnostics copied.');
							});
						}}
					>
						Copy diagnostics
					</Button>
					{report.reports && (
						<Button
							variant="primary"
							onPress={() => void send()}
							isDisabled={delivery !== 'idle' || !trimmedMessage}
						>
							{delivery === 'sending' ? 'Sending…' : 'Send report'}
						</Button>
					)}
					{!report.loading && !report.reports && support_url && (
						<a
							href={support_url}
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm text-primary underline"
						>
							Open support portal
						</a>
					)}
				</div>
			</div>
		</DialogModal>
	);
}

export function ReportProblemAction(context: ReportContext) {
	const { open, dialog } = useProblemReport(context);
	const { support_url } = useBranding();
	return (
		<>
			<div className="flex items-center gap-3">
				<Button variant="ghost" onPress={() => void open()}>
					Report a problem
				</Button>
				{support_url && (
					<a
						href={support_url}
						target="_blank"
						rel="noopener noreferrer"
						className="text-sm text-primary underline"
					>
						Get help
					</a>
				)}
			</div>
			{dialog}
		</>
	);
}
