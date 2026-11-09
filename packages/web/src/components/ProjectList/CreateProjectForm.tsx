import { toast } from 'sonner';
import { z } from 'zod';
import { useCreateProject } from '@/api/hooks';
import {
	FormDialog,
	optionalText,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';

const projectSchema = z.object({ name: requiredText('Project name'), description: optionalText() });
const EMPTY_PROJECT = { name: '', description: '' };

export function CreateProjectForm({
	isOpen,
	onClose,
	onCreated,
}: {
	isOpen: boolean;
	onClose: () => void;
	onCreated?: (id: string) => void;
}) {
	const createProject = useCreateProject();
	const form = useAppForm({
		defaultValues: EMPTY_PROJECT,
		validators: schemaValidators(projectSchema),
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			try {
				const project = await createProject.mutateAsync({
					name,
					description: value.description.trim() || name,
				});
				toast.success(`Created project "${name}"`);
				onClose();
				onCreated?.(project.id);
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(form, isOpen, EMPTY_PROJECT);
	return (
		<FormDialog
			form={form}
			isPending={createProject.isPending}
			isOpen={isOpen}
			onClose={onClose}
			title="Create New Project"
			submitLabel="Create"
			pendingLabel="Creating…"
		>
			<form.AppField name="name">
				{(field) => <field.TextField label="Project Name" placeholder="My Analysis" autoFocus />}
			</form.AppField>
			<form.AppField name="description">
				{(field) => <field.TextField label="Description" placeholder="Optional description" />}
			</form.AppField>
		</FormDialog>
	);
}
