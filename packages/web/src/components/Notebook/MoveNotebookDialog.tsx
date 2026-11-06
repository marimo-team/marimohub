import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiRequestError } from '@/api/client';
import { useProjectsQuery } from '@/api/hooks';
import { useCancelNotebookMove, useMoveNotebook } from '@/api/notebookMoves';
import { FormDialog, requiredText, schemaValidators, useAppForm } from '@/components/form';
import { Button } from '@/components/ui';
import { Callout } from '@/components/ui/Callout';

const schema = z.object({ destination: requiredText('Destination project') });

// Only an interrupted or contended move recovers by repeating it; 403/412/422 need a different action.
function isResumable(error: Error): boolean {
	if (!(error instanceof ApiRequestError)) return false;
	if (error.code === 'NETWORK_ERROR') return true;
	return error.status === 409 || (error.status !== undefined && error.status >= 500);
}

export function MoveNotebookDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
}: {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: {
		id: string;
		title: string;
		updated_at: string;
		source_type: string;
		moving?: { destination_project_id: string };
	};
}) {
	const navigate = useNavigate();
	const projects = useProjectsQuery(
		{ managed_only: 'true', status: 'active' },
		{ enabled: isOpen, throwOnError: false },
	);
	const move = useMoveNotebook(projectId);
	const cancelMove = useCancelNotebookMove(projectId);
	// The move outlives a closed dialog; only an open dialog may navigate on success.
	const isOpenRef = useRef(isOpen);
	useEffect(() => {
		isOpenRef.current = isOpen;
		return () => {
			isOpenRef.current = false;
		};
	}, [isOpen]);

	const destinations = projects.data?.filter((project) => project.id !== projectId) ?? [];
	const form = useAppForm({
		defaultValues: { destination: notebook.moving?.destination_project_id ?? '' },
		validators: schemaValidators(schema),
		onSubmit: async ({ value }) => {
			try {
				const result = await move.mutateAsync({
					notebookId: notebook.id,
					destination: value.destination,
					updatedAt: notebook.updated_at,
				});
				toast.success(`Moved "${notebook.title}"`);
				if (!isOpenRef.current) return;
				onClose();
				void navigate(`/projects/${result.project_id}`);
			} catch {
				return;
			}
		},
	});
	const isPending = move.isPending || cancelMove.isPending;
	const handleCancelMove = async () => {
		const destination = move.variables?.destination;
		if (destination === undefined) return;
		try {
			await cancelMove.mutateAsync({ notebookId: notebook.id, destination });
		} catch {
			return;
		}
		toast.success(`Cancelled the move of "${notebook.title}"`);
		move.reset();
		form.reset({ destination: '' });
	};
	return (
		<FormDialog
			form={form}
			isOpen={isOpen}
			onClose={() => {
				if (!isPending) onClose();
			}}
			isPending={move.isPending}
			title="Move notebook"
			submitLabel={notebook.moving ? 'Resume move' : 'Move'}
			pendingLabel="Moving…"
			submitDisabled={destinations.length === 0 || cancelMove.isPending}
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
								isDisabled={isPending}
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
				<Callout variant="error" className="flex flex-col items-start gap-2 text-destructive">
					<p>
						{move.error.message}
						{isResumable(move.error) &&
							' An interrupted move resumes when you move to the same destination again.'}
					</p>
					{move.error instanceof ApiRequestError && move.error.status === 409 && (
						<Button
							variant="default"
							size="sm"
							isDisabled={isPending}
							onPress={() => void handleCancelMove()}
						>
							{cancelMove.isPending ? 'Cancelling move…' : 'Cancel move'}
						</Button>
					)}
				</Callout>
			)}
		</FormDialog>
	);
}
