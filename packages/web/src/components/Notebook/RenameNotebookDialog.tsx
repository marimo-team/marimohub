import { toast } from 'sonner';
import { z } from 'zod';
import {
	FormDialog,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import { useUpdateNotebook } from '@/api/hooks';

interface RenameNotebookDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string };
}

const renameSchema = z.object({ title: requiredText('Notebook name') });

export function RenameNotebookDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
}: RenameNotebookDialogProps) {
	const updateNotebook = useUpdateNotebook(projectId);
	const form = useAppForm({
		defaultValues: { title: notebook.title },
		validators: schemaValidators(renameSchema),
		onSubmit: async ({ value }) => {
			const name = value.title.trim();
			try {
				await updateNotebook.mutateAsync({ notebookId: notebook.id, title: name });
				toast.success(`Renamed to "${name}"`);
				onClose();
			} catch (err) {
				toast.error((err as Error).message);
			}
		},
	});
	// Re-seed each open for a (possibly different) notebook.
	useSeedOnOpen(form, isOpen, { title: notebook.title });

	return (
		<FormDialog
			form={form}
			isPending={updateNotebook.isPending}
			isOpen={isOpen}
			onClose={onClose}
			title="Rename Notebook"
			submitLabel="Save"
			pendingLabel="Saving..."
		>
			<form.AppField name="title">
				{(f) => <f.TextField label="Notebook Name" placeholder="my_analysis" autoFocus />}
			</form.AppField>
		</FormDialog>
	);
}
