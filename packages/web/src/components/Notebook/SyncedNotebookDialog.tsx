import { useEffect } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useSelector } from '@tanstack/react-store';
import {
	FormDialog,
	optionalText,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import { useCapabilitiesQuery, useCreateSyncedNotebook } from '@/api/hooks';
import {
	ENTRY_NOTEBOOK_HINT,
	ENTRY_NOTEBOOK_PATTERN,
	GITHUB_REPO_INPUT_HINT,
	isGitHubRepoInput,
	isRepoInput,
	REPO_INPUT_HINT,
} from '@/lib/git';

export interface SyncedNotebookCreated {
	notebookId: string;
	title: string;
	syncUrl?: string;
	token?: string;
	syncMode: 'push' | 'pull';
}

export interface SyncedNotebookDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	onCreated: (result: SyncedNotebookCreated) => void;
}

const syncedSchema = z
	.object({
		syncMode: z.enum(['push', 'pull']),
		title: requiredText('Notebook name'),
		repo: requiredText('Repository').refine(isRepoInput, REPO_INPUT_HINT),
		branch: requiredText('Branch'),
		rootPath: optionalText(),
		entryNotebook: requiredText('Notebook file').regex(ENTRY_NOTEBOOK_PATTERN, ENTRY_NOTEBOOK_HINT),
	})
	.superRefine((value, context) => {
		if (value.syncMode === 'pull' && isRepoInput(value.repo) && !isGitHubRepoInput(value.repo)) {
			context.addIssue({
				code: 'custom',
				path: ['repo'],
				message: GITHUB_REPO_INPUT_HINT,
			});
		}
	});

const emptyValues = (syncMode: 'push' | 'pull') => ({
	syncMode,
	title: '',
	repo: '',
	branch: 'main',
	rootPath: '',
	entryNotebook: '',
});

export function SyncedNotebookDialog({
	isOpen,
	onClose,
	projectId,
	onCreated,
}: SyncedNotebookDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const pullAvailable = (capabilities?.source_control?.pull_source_providers ?? []).includes(
		'github',
	);
	const initialValues = emptyValues(pullAvailable ? 'pull' : 'push');
	const createSynced = useCreateSyncedNotebook(projectId);
	const form = useAppForm({
		defaultValues: initialValues,
		validators: schemaValidators(syncedSchema),
		onSubmit: async ({ value }) => {
			try {
				const data = await createSynced.mutateAsync({
					title: value.title.trim(),
					description: value.title.trim(),
					repo: value.repo.trim(),
					branch: value.branch.trim(),
					root_path: value.syncMode === 'pull' ? '' : value.rootPath.trim() || undefined,
					entry_notebook: value.entryNotebook.trim(),
					sync_mode: value.syncMode,
				});
				if (data.sync_error) {
					toast.warning(`Created "${data.notebook.title}", but the first sync failed`, {
						description: data.sync_error.message,
					});
				} else {
					toast.success(`Created "${data.notebook.title}"`);
				}
				onCreated({
					notebookId: data.notebook.id,
					title: data.notebook.title,
					syncUrl: data.sync_url,
					token: data.sync_token,
					syncMode: value.syncMode,
				});
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(form, isOpen, initialValues);
	useEffect(() => {
		if (isOpen && pullAvailable) form.setFieldValue('syncMode', 'pull');
	}, [form, isOpen, pullAvailable]);
	const syncMode = useSelector(form.store, (state) => state.values.syncMode);

	return (
		<FormDialog
			form={form}
			isPending={createSynced.isPending}
			isOpen={isOpen}
			onClose={onClose}
			title="Add a git repository"
			submitLabel="Create"
			pendingLabel="Creating..."
		>
			{pullAvailable && (
				<form.AppField name="syncMode">
					{(f) => (
						<f.RadioGroupField
							label="How content is synced"
							options={[
								{
									value: 'pull',
									label: 'Connect to GitHub',
									description: 'The server pulls the repository; no CI setup is required.',
								},
								{
									value: 'push',
									label: 'Push from CI',
									description: 'An external workflow pushes repository archives.',
								},
							]}
						/>
					)}
				</form.AppField>
			)}
			<form.AppField name="title">
				{(f) => <f.TextField label="Notebook name" placeholder="my_dashboard" autoFocus />}
			</form.AppField>
			<form.AppField name="repo">
				{(f) => (
					<f.TextField
						label="Repository"
						placeholder={
							syncMode === 'pull'
								? 'owner/repo'
								: 'owner/repo or https://gitlab.example.com/group/project'
						}
					/>
				)}
			</form.AppField>
			<form.AppField name="branch">
				{(f) => <f.TextField label="Branch" placeholder="main" />}
			</form.AppField>
			{syncMode === 'push' && (
				<form.AppField name="rootPath">
					{(f) => <f.TextField label="Folder in repo (optional)" placeholder="apps" />}
				</form.AppField>
			)}
			<form.AppField name="entryNotebook">
				{(f) => <f.TextField label="Notebook file" placeholder="dashboard.py" />}
			</form.AppField>
		</FormDialog>
	);
}
