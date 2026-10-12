import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { useCapabilitiesQuery, useNotebookQuery, useUpdateNotebook } from '@/api/hooks';
import {
	computeProfileOptions,
	computeProfilePickerValue,
	DEFAULT_COMPUTE_PROFILE,
	effectiveComputeProfile,
	hasSeparateAppProfiles,
	modeComputeProfile,
	modeComputeProfiles,
} from './computeProfiles';

type RestartAction = { label: string; onRestart: () => void };

interface ChangeComputeProfileDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
	restartActions?: Partial<Record<'edit' | 'app', RestartAction>>;
}

const storedChoice = (value: string) => (value === DEFAULT_COMPUTE_PROFILE ? undefined : value);

const toastAction = ({ label, onRestart }: RestartAction) => ({ label, onClick: onRestart });

export function ChangeComputeProfileDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
	restartActions,
}: ChangeComputeProfileDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const detail = useNotebookQuery(projectId, notebook.id);
	const separateApp = hasSeparateAppProfiles(capabilities);
	const profiles = modeComputeProfiles(capabilities, 'edit');
	const appProfiles = modeComputeProfiles(capabilities, 'app');
	const stored = detail.data?.meta.compute_profile;
	const appStored = detail.data?.meta.app_compute_profile;
	const current = computeProfilePickerValue(profiles, stored);
	// In shared mode an explicit first profile pins the app, so it must not collapse into the
	// inherit-editing default.
	const appCurrent = separateApp
		? computeProfilePickerValue(appProfiles, appStored)
		: (appStored ?? DEFAULT_COMPUTE_PROFILE);
	const stale =
		(!!stored && !profiles.some((p) => p.name === stored)) ||
		(!!appStored && !appProfiles.some((p) => p.name === appStored));
	const options = computeProfileOptions(profiles, stored);
	const appOptions = computeProfileOptions(
		appProfiles,
		appStored,
		separateApp ? {} : { defaultLabel: 'Use editing profile', includeFirst: true },
	);
	const appProfileFor = (editChoice: string, appChoice: string) =>
		effectiveComputeProfile(
			appProfiles,
			modeComputeProfile(
				{ compute_profile: storedChoice(editChoice), app_compute_profile: storedChoice(appChoice) },
				'app',
				separateApp,
			),
			true,
		);
	const updateNotebook = useUpdateNotebook(projectId);
	const form = useAppForm({
		defaultValues: { computeProfile: current, appComputeProfile: appCurrent },
		onSubmit: async ({ value }) => {
			const editChanged = value.computeProfile !== current;
			try {
				await updateNotebook.mutateAsync({
					notebookId: notebook.id,
					...(editChanged ? { compute_profile: storedChoice(value.computeProfile) ?? null } : {}),
					...(value.appComputeProfile !== appCurrent
						? { app_compute_profile: storedChoice(value.appComputeProfile) ?? null }
						: {}),
				});
			} catch {
				return;
			}
			const editRestart = editChanged ? restartActions?.edit : undefined;
			const appRestart =
				appProfileFor(value.computeProfile, value.appComputeProfile) !==
				appProfileFor(current, appCurrent)
					? restartActions?.app
					: undefined;
			const [action, cancel] = [editRestart, appRestart].filter(
				(restart): restart is RestartAction => restart !== undefined,
			);
			toast.success('Compute profiles saved. Applies when each session restarts.', {
				...(action ? { action: toastAction(action) } : {}),
				...(cancel ? { cancel: toastAction(cancel) } : {}),
			});
			onClose();
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
