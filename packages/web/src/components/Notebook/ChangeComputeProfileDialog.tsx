import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { useCapabilitiesQuery, useNotebookQuery, useUpdateNotebook } from '@/api/hooks';
import {
	computeProfileOptions,
	effectiveComputeProfile,
	computeProfileResources,
	computeProfilePickerValue,
	DEFAULT_COMPUTE_PROFILE,
} from './computeProfiles';

interface ChangeComputeProfileDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
	restartActions?: Partial<Record<'edit' | 'app', { label: string; onRestart: () => void }>>;
}

export function ChangeComputeProfileDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
	restartActions,
}: ChangeComputeProfileDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const profiles = capabilities?.compute_profiles ?? [];
	const detail = useNotebookQuery(projectId, notebook.id);
	const editProfiles = profiles;
	const appProfiles = capabilities?.app_compute_profiles ?? profiles;
	const stored = detail.data?.meta.compute_profile;
	const appStored = detail.data?.meta.app_compute_profile;
	const current = computeProfilePickerValue(editProfiles, stored);
	const appCurrent = appStored ?? DEFAULT_COMPUTE_PROFILE;
	const stale =
		(!!stored && !editProfiles.some((p) => p.name === stored)) ||
		(!!appStored && !appProfiles.some((p) => p.name === appStored));
	const options = computeProfileOptions(editProfiles, stored);
	const appOptions = [
		{
			value: DEFAULT_COMPUTE_PROFILE,
			label: capabilities?.app_compute_profiles
				? `Default (${appProfiles[0]?.name})`
				: 'Use editing profile',
		},
		...appProfiles.map((profile) => ({
			value: profile.name,
			label: profile.name,
			description: computeProfileResources(profile),
		})),
		...computeProfileOptions(appProfiles, appStored).filter((option) => option.isDisabled),
	];
	const updateNotebook = useUpdateNotebook(projectId);
	const form = useAppForm({
		defaultValues: { computeProfile: current, appComputeProfile: appCurrent },
		onSubmit: async ({ value }) => {
			const choice = value.computeProfile === DEFAULT_COMPUTE_PROFILE ? null : value.computeProfile;
			try {
				await updateNotebook.mutateAsync({
					notebookId: notebook.id,
					...(value.computeProfile !== current ? { compute_profile: choice } : {}),
					...(value.appComputeProfile !== appCurrent
						? {
								app_compute_profile:
									value.appComputeProfile === DEFAULT_COMPUTE_PROFILE
										? null
										: value.appComputeProfile,
							}
						: {}),
				});
				const appProfile = (editChoice: string, appChoice: string) =>
					effectiveComputeProfile(
						appProfiles,
						appChoice === DEFAULT_COMPUTE_PROFILE
							? capabilities?.app_compute_profiles
								? undefined
								: editChoice
							: appChoice,
						true,
					);
				const restartAction =
					(value.computeProfile !== current ? restartActions?.edit : undefined) ??
					(appProfile(value.computeProfile, value.appComputeProfile) !==
					appProfile(current, appCurrent)
						? restartActions?.app
						: undefined);
				toast.success(
					'Compute profiles saved. Applies when each session restarts.',
					restartAction
						? { action: { label: restartAction.label, onClick: restartAction.onRestart } }
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
