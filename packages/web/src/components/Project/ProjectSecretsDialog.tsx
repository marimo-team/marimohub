import { ExternalLink, KeyRound } from 'lucide-react';
import { Button, DialogModal } from '@/components/ui';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { DOCS_FEDERATION_URL } from '@/lib/links';
import type { ProjectDetail } from '@/types';

export interface ProjectSecretsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
	/** Whether the deployment has Workload Identity Federation configured. */
	available: boolean;
	onSave: (enabled: boolean) => void;
	isPending?: boolean;
}

/**
 * Per-project secrets dialog: an enable/disable toggle for federated bucket
 * access when the deployment supports it, or a pointer to the setup docs when it
 * doesn't.
 */
export function ProjectSecretsDialog({
	isOpen,
	onClose,
	project,
	available,
	onSave,
	isPending = false,
}: ProjectSecretsDialogProps) {
	const current = project.federation?.enabled ?? false;
	const form = useAppForm({
		defaultValues: { enabled: current },
		onSubmit: ({ value }) => onSave(value.enabled),
	});
	// Re-seed to the persisted value each open so a cancelled edit doesn't leak.
	useSeedOnOpen(form, isOpen, { enabled: current });

	if (!available) {
		return (
			<DialogModal isOpen={isOpen} onClose={onClose} title="Project secrets" width="md">
				<div className="flex flex-col gap-4 text-sm">
					<p className="text-muted-foreground">
						Give this project's notebooks short-lived, auto-expiring credentials for a cloud bucket
						— no long-lived keys stored anywhere. This deployment hasn't enabled it yet.
					</p>
					<a
						href={DOCS_FEDERATION_URL}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
					>
						How to enable it
						<ExternalLink className="size-3.5" />
					</a>
					<div className="flex justify-end pt-2">
						<Button variant="ghost" onPress={onClose}>
							Close
						</Button>
					</div>
				</div>
			</DialogModal>
		);
	}

	return (
		<FormDialog
			form={form}
			isPending={isPending}
			requireDirty
			isOpen={isOpen}
			onClose={onClose}
			title="Project secrets"
			submitLabel="Save"
			pendingLabel="Saving..."
			width="md"
		>
			<p className="text-sm text-muted-foreground">
				When enabled, sessions in this project receive short-lived bucket credentials as standard{' '}
				<code className="text-xs">AWS_*</code> environment variables.
			</p>
			<form.AppField name="enabled">
				{(f) => (
					<f.SwitchField>
						{(isSelected) => (
							<span className="flex items-center gap-1.5 text-sm font-medium">
								<KeyRound className="size-4" />
								Federated bucket access {isSelected ? 'enabled' : 'disabled'}
							</span>
						)}
					</f.SwitchField>
				)}
			</form.AppField>
		</FormDialog>
	);
}
