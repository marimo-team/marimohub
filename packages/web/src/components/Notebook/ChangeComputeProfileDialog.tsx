import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { useCapabilitiesQuery, useNotebookQuery, useUpdateNotebook } from '@/api/hooks';
import {
	computeProfileOptions,
	modeComputeProfile,
	profilesForMode,
	computeProfilePickerValue,
	DEFAULT_COMPUTE_PROFILE,
} from './computeProfiles';

interface ChangeComputeProfileDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
	restartAction?: { label: string; onRestart: () => void; mode?: 'edit' | 'app' };
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
	const editProfiles = profilesForMode(profiles, capabilities?.edit_compute_profile);
	const appProfiles = profilesForMode(profiles, capabilities?.app_compute_profile);
	const stored = modeComputeProfile(detail.data?.meta, 'edit');
	const appStored = modeComputeProfile(detail.data?.meta, 'app');
	const current = computeProfilePickerValue(editProfiles, stored);
	const appCurrent = computeProfilePickerValue(appProfiles, appStored);
	const stale = [stored, appStored].some(
		(name) => !!name && !profiles.some((profile) => profile.name === name),
	);
	const options = computeProfileOptions(editProfiles, stored);
	const appOptions = computeProfileOptions(appProfiles, appStored);
	const updateNotebook = useUpdateNotebook(projectId);
	const form = useAppForm({
		defaultValues: { computeProfile: current, appComputeProfile: appCurrent },
		onSubmit: async ({ value }) => {
			const choice = value.computeProfile === DEFAULT_COMPUTE_PROFILE ? null : value.computeProfile;
			try {
				await updateNotebook.mutateAsync({
					notebookId: notebook.id,
					...(value.computeProfile !== current ? { edit_compute_profile: choice } : {}),
					...(value.appComputeProfile !== appCurrent
						? {
								app_compute_profile:
									value.appComputeProfile === DEFAULT_COMPUTE_PROFILE
										? null
										: value.appComputeProfile,
							}
						: {}),
				});
				toast.success(
					'Compute profiles saved. Applies when each session restarts.',
					restartAction &&
						(restartAction.mode === 'app'
							? value.appComputeProfile !== appCurrent
							: value.computeProfile !== current)
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
	useSeedOnOpen(form, isOpen && detail.isSuccess, {
		computeProfile: current,
		appComputeProfile: appCurrent,
	});

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
				Choose separate resources for editing "{notebook.title}" and running it as an app.
			</p>
			{stale && (
				<p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
					<AlertTriangle className="size-3.5 shrink-0" />
					A selected profile was removed by your operator. New sessions use the corresponding
					default.
				</p>
			)}
			<form.AppField name="computeProfile">
				{(field) => <field.RadioGroupField label="Editing profile" options={options} />}
			</form.AppField>
			<form.AppField name="appComputeProfile">
				{(field) => <field.RadioGroupField label="App profile" options={appOptions} />}
			</form.AppField>
		</FormDialog>
	);
}
