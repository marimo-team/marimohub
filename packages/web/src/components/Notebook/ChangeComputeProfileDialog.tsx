import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { useCapabilitiesQuery, useNotebookQuery, useUpdateNotebook } from '@/api/hooks';
import {
	computeProfileOptions,
	computeProfilePickerValue,
	DEFAULT_COMPUTE_PROFILE,
} from './computeProfiles';

interface ChangeComputeProfileDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
	restartAction?: { label: string; onRestart: () => void };
}

export function ChangeComputeProfileDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
	restartAction,
}: ChangeComputeProfileDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const profiles = capabilities?.compute_profiles ?? [];
	const detail = useNotebookQuery(projectId, notebook.id);
	const stored = detail.data?.meta.compute_profile;
	const current = computeProfilePickerValue(profiles, stored);
	const stale = !!stored && !profiles.some((profile) => profile.name === stored);
	const options = computeProfileOptions(profiles, stored);
	const updateNotebook = useUpdateNotebook(projectId);
	const form = useAppForm({
		defaultValues: { computeProfile: current },
		onSubmit: async ({ value }) => {
			const choice = value.computeProfile === DEFAULT_COMPUTE_PROFILE ? null : value.computeProfile;
			try {
				await updateNotebook.mutateAsync({
					notebookId: notebook.id,
					compute_profile: choice,
				});
				const selectedName = choice ?? profiles[0]?.name ?? 'default';
				toast.success(
					`Compute set to ${selectedName}. Applies when the notebook session restarts.`,
					restartAction
						? {
								action: {
									label: restartAction.label,
									onClick: restartAction.onRestart,
								},
							}
						: undefined,
				);
				onClose();
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(form, isOpen && detail.isSuccess, { computeProfile: current });

	return (
		<FormDialog
			form={form}
			isPending={updateNotebook.isPending}
			submitDisabled={!detail.isSuccess}
			requireDirty
			isOpen={isOpen}
			onClose={onClose}
			title="Change Compute"
			submitLabel="Save"
			pendingLabel="Saving..."
		>
			<p className="text-xs text-muted-foreground">
				The compute profile "{notebook.title}" uses when a session starts.
			</p>
			{stale && (
				<p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
					<AlertTriangle className="size-3.5 shrink-0" />
					{stored} was removed by your operator. New sessions use Default until you choose another
					profile.
				</p>
			)}
			<form.AppField name="computeProfile">
				{(field) => <field.RadioGroupField label="Compute profile" options={options} />}
			</form.AppField>
		</FormDialog>
	);
}
