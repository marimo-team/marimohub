import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { useProjectsQuery } from '@/api/hooks';
import { useMoveNotebook } from '@/api/notebookMoves';
import { FormDialog, requiredText, schemaValidators, useAppForm } from '@/components/form';

const schema = z.object({ destination: requiredText('Destination project') });

export function MoveNotebookDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
}: {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: { id: string; title: string; updated_at: string; source_type: string };
}) {
	const navigate = useNavigate();
	const projects = useProjectsQuery(
		{ managed_only: 'true' },
		{ enabled: isOpen, throwOnError: false },
	);
	const move = useMoveNotebook(projectId);

	const destinations =
		projects.data?.filter((project) => project.id !== projectId && project.status !== 'deleted') ??
		[];
	const form = useAppForm({
		defaultValues: { destination: '' },
		validators: schemaValidators(schema),
		onSubmit: async ({ value }) => {
			try {
				const result = await move.mutateAsync({
					notebookId: notebook.id,
					destination: value.destination,
					updatedAt: notebook.updated_at,
				});
				toast.success(`Moved "${notebook.title}"`);
				onClose();
				void navigate(`/projects/${result.project_id}`);
			} catch {
				return;
			}
		},
	});
	return (
		<FormDialog
			form={form}
			isOpen={isOpen}
			onClose={onClose}
			isPending={move.isPending}
			title="Move notebook"
			submitLabel="Move"
			pendingLabel="Moving…"
			submitDisabled={destinations.length === 0}
		>
			<p className="text-sm">
				Move “{notebook.title}” and its history to another project. Members of the destination
				project will have access.
			</p>
			<p className="text-sm text-muted-foreground">
				Stop notebook sessions and jobs first. The notebook will use the destination project's
				integrations, credentials, and alerts.
			</p>
			{notebook.source_type === 'git' && (
				<p className="text-sm text-muted-foreground">
					The Git repository stays the same. For push sync, generate a new token and update the CI
					sync URL after the move.
				</p>
			)}
			{projects.isPending ? (
				<p>Loading projects…</p>
			) : projects.isError ? (
				<p role="alert">Could not load destination projects.</p>
			) : destinations.length === 0 ? (
				<p>No other projects are available. You need manager or admin access in both projects.</p>
			) : (
				<div className="max-h-64 overflow-y-auto">
					<form.AppField name="destination">
						{(field) => (
							<field.RadioGroupField
								label="Destination project"
								isDisabled={move.isPending}
								options={destinations.map((project) => ({
									value: project.id,
									label: project.name,
								}))}
							/>
						)}
					</form.AppField>
				</div>
			)}
			{move.error && (
				<p role="alert" className="text-sm text-destructive">
					{move.error.message}
					{' An interrupted move resumes when you move to the same destination again.'}
				</p>
			)}
		</FormDialog>
	);
}
