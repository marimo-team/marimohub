import { toast } from 'sonner';
import { FormDialog, useAppForm, useSeedOnOpen } from '@/components/form';
import { useNotebookQuery, useUpdateNotebook } from '@/api/hooks';
import { baseImageOptions, DEFAULT_BASE_IMAGE, imageLabel, useSandboxImages } from './baseImage';

interface ChangeBaseImageDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
}

/**
 * Pick the sandbox image the notebook's sessions boot from. "Default" clears the
 * stored choice so the notebook follows the deployment's first configured image.
 */
export function ChangeBaseImageDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
}: ChangeBaseImageDialogProps) {
	const images = useSandboxImages();
	const detail = useNotebookQuery(projectId, notebook.id);
	const current = detail.data?.meta.base_image ?? DEFAULT_BASE_IMAGE;
	const updateNotebook = useUpdateNotebook(projectId);
	const form = useAppForm({
		defaultValues: { baseImage: current },
		onSubmit: async ({ value }) => {
			const choice = value.baseImage;
			try {
				await updateNotebook.mutateAsync({
					notebookId: notebook.id,
					base_image: choice === DEFAULT_BASE_IMAGE ? null : choice,
				});
				toast.success(
					choice === DEFAULT_BASE_IMAGE
						? 'Base image reset to default'
						: `Base image set to "${imageLabel(choice)}"`,
				);
				onClose();
			} catch (err) {
				toast.error((err as Error).message);
			}
		},
	});
	// Seed once the current choice is KNOWN. Gating on success (not just
	// !isLoading) keeps a failed detail fetch from seeding "Default" — saving
	// that would silently clear a stored choice the user never saw.
	useSeedOnOpen(form, isOpen && detail.isSuccess, { baseImage: current });

	return (
		<FormDialog
			form={form}
			isPending={updateNotebook.isPending}
			submitDisabled={!detail.isSuccess}
			isOpen={isOpen}
			onClose={onClose}
			title="Change Base Image"
			submitLabel="Save"
			pendingLabel="Saving..."
			width="lg"
		>
			<p className="text-xs text-muted-foreground">
				The image "{notebook.title}" runs on. Takes effect the next time a session starts.
			</p>
			<form.AppField name="baseImage">
				{(f) => <f.RadioGroupField label="Base image" options={baseImageOptions(images)} />}
			</form.AppField>
		</FormDialog>
	);
}
