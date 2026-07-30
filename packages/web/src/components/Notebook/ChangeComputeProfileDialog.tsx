import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { useCapabilitiesQuery, useNotebookQuery, useUpdateNotebook } from '@/api/hooks';
import type { RadioGroupFieldOption } from '@/components/form/fields/RadioGroupField';
import { computeProfileResources } from './ComputeProfileSelect';

export const DEFAULT_COMPUTE_PROFILE = '__marimohub_default_compute__';

interface ChangeComputeProfileDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
	canRestart?: boolean;
	onRestart?: () => void;
}

export function ChangeComputeProfileDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
	canRestart = false,
	onRestart,
}: ChangeComputeProfileDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const profiles = capabilities?.compute_profiles ?? [];
	const detail = useNotebookQuery(projectId, notebook.id);
	const stored = detail.data?.meta.compute_profile;
	const current = stored ?? DEFAULT_COMPUTE_PROFILE;
	const stale = !!stored && !profiles.some((profile) => profile.name === stored);
	const options: RadioGroupFieldOption[] = profiles[0]
		? [
				{
					value: DEFAULT_COMPUTE_PROFILE,
					label: `Default (${profiles[0].name})`,
					description: computeProfileResources(profiles[0]),
				},
				...profiles.slice(1).map((profile) => ({
					value: profile.name,
					label: profile.name,
					description: computeProfileResources(profile),
				})),
				...(stale
					? [
							{
								value: stored,
								label: `${stored} (unavailable)`,
								description: 'Removed by your operator',
								isDisabled: true,
							},
						]
					: []),
			]
		: [];
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
					canRestart && onRestart
						? {
								action: {
									label: 'Restart session',
									onClick: onRestart,
								},
							}
						: undefined,
				);
				onClose();
			} catch (err) {
				toast.error((err as Error).message);
			}
		},
	});
	useSeedOnOpen(form, isOpen && detail.isSuccess, { computeProfile: current });

	return (
		<FormDialog
			form={form}
			isPending={updateNotebook.isPending}
			submitDisabled={!detail.isSuccess}
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
