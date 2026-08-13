import { toast } from 'sonner';
import { z } from 'zod';
import {
	FormDialog,
	optionalText,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import { useCreateSyncedNotebook } from '@/api/hooks';
import {
	ENTRY_NOTEBOOK_HINT,
	ENTRY_NOTEBOOK_PATTERN,
	isRepoInput,
	REPO_INPUT_HINT,
} from '@/lib/git';

export interface SyncedNotebookCreated {
	notebookId: string;
	title: string;
	syncUrl: string;
	token: string;
}

export interface SyncedNotebookDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	/** Fired after a successful create, with the write-once sync credentials. */
	onCreated: (result: SyncedNotebookCreated) => void;
}

const syncedSchema = z.object({
	title: requiredText('Notebook name'),
	repo: requiredText('Repository').refine(isRepoInput, REPO_INPUT_HINT),
	branch: requiredText('Branch'),
	rootPath: optionalText(),
	entryNotebook: requiredText('Notebook file').regex(ENTRY_NOTEBOOK_PATTERN, ENTRY_NOTEBOOK_HINT),
});

const EMPTY = { title: '', repo: '', branch: 'main', rootPath: '', entryNotebook: '' };

/**
 * Create a git-synced notebook. A repo subtree is mirrored in by an external
 * pusher (e.g. a CI workflow); see `docs/syncing.md`. The resulting write-once
 * token is handed to `onCreated` for the caller to surface (the server never
 * returns it again).
 */
export function SyncedNotebookDialog({
	isOpen,
	onClose,
	projectId,
	onCreated,
}: SyncedNotebookDialogProps) {
	const createSynced = useCreateSyncedNotebook(projectId);
	const form = useAppForm({
		defaultValues: EMPTY,
		validators: schemaValidators(syncedSchema),
		onSubmit: async ({ value }) => {
			try {
				const data = await createSynced.mutateAsync({
					title: value.title.trim(),
					description: value.title.trim(),
					repo: value.repo.trim(),
					branch: value.branch.trim(),
					root_path: value.rootPath.trim() || undefined,
					entry_notebook: value.entryNotebook.trim(),
				});
				toast.success(`Created "${data.notebook.title}"`);
				onCreated({
					notebookId: data.notebook.id,
					title: data.notebook.title,
					syncUrl: data.sync_url,
					token: data.sync_token,
				});
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(form, isOpen, EMPTY);

	return (
		<FormDialog
			form={form}
			isPending={createSynced.isPending}
			isOpen={isOpen}
			onClose={onClose}
			title="Sync from a git repository"
			submitLabel="Create"
			pendingLabel="Creating..."
		>
			<form.AppField name="title">
				{(f) => <f.TextField label="Notebook name" placeholder="my_dashboard" autoFocus />}
			</form.AppField>
			<form.AppField name="repo">
				{(f) => (
					<f.TextField
						label="Repository"
						placeholder="owner/repo or https://gitlab.example.com/group/project"
					/>
				)}
			</form.AppField>
			<form.AppField name="branch">
				{(f) => <f.TextField label="Branch" placeholder="main" />}
			</form.AppField>
			<form.AppField name="rootPath">
				{(f) => <f.TextField label="Folder in repo (optional)" placeholder="apps" />}
			</form.AppField>
			<form.AppField name="entryNotebook">
				{(f) => <f.TextField label="Notebook file" placeholder="dashboard.py" />}
			</form.AppField>
		</FormDialog>
	);
}
