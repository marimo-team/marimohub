import { useEffect } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useSelector } from '@tanstack/react-store';
import {
	FormDialog,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import { useCapabilitiesQuery, useCreateSyncedNotebook } from '@/api/hooks';
import {
	ENTRY_NOTEBOOK_HINT,
	ENTRY_NOTEBOOK_PATTERN,
	pullRepositoryInput,
	isRepoInput,
	normalizeRootPathInput,
	REPO_INPUT_HINT,
	rootPathText,
} from '@/lib/git';
import { baseImageOptions, DEFAULT_BASE_IMAGE } from './baseImage';
import { computeProfileOptions, DEFAULT_COMPUTE_PROFILE } from './computeProfiles';

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
	canManage?: boolean;
	onCreated: (result: SyncedNotebookCreated) => void;
}

const syncedSchema = (pullInput: ReturnType<typeof pullRepositoryInput>) =>
	z
		.object({
			syncMode: z.enum(['push', 'pull']),
			newBranch: z.enum(['no', 'yes']),
			title: requiredText('Notebook name'),
			repo: requiredText('Repository').refine(isRepoInput, REPO_INPUT_HINT),
			branch: requiredText('Branch'),
			rootPath: rootPathText(),
			entryNotebook: requiredText('Notebook file').regex(
				ENTRY_NOTEBOOK_PATTERN,
				ENTRY_NOTEBOOK_HINT,
			),
			baseImage: z.string(),
			computeProfile: z.string(),
		})
		.superRefine((value, context) => {
			if (value.syncMode === 'pull' && isRepoInput(value.repo) && !pullInput.validate(value.repo)) {
				context.addIssue({
					code: 'custom',
					path: ['repo'],
					message: pullInput.hint || 'No pull source provider is configured',
				});
			}
		});

const emptyValues = (syncMode: 'push' | 'pull', canManage: boolean) => ({
	syncMode,
	newBranch: canManage ? ('no' as const) : ('yes' as const),
	title: '',
	repo: '',
	branch: 'main',
	rootPath: '',
	entryNotebook: '',
	baseImage: DEFAULT_BASE_IMAGE,
	computeProfile: DEFAULT_COMPUTE_PROFILE,
});

export function SyncedNotebookDialog({
	isOpen,
	onClose,
	projectId,
	canManage = true,
	onCreated,
}: SyncedNotebookDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const branchProviders = capabilities?.source_control?.working_branch_providers ?? [];
	const branchInput = pullRepositoryInput(branchProviders);
	const pullProviders = capabilities?.source_control?.pull_source_providers ?? [];
	const pullInput = pullRepositoryInput(pullProviders);
	const pullAvailable = pullInput.available;
	const pullLabel = pullInput.label;
	const sandboxImages = capabilities?.sandbox_images ?? [];
	const offersImageChoice = sandboxImages.length > 1;
	const computeProfiles = capabilities?.compute_profiles ?? [];
	const offersComputeChoice =
		capabilities?.compute_profile_override === 'editors' && computeProfiles.length > 1;
	const initialValues = emptyValues(pullAvailable ? 'pull' : 'push', canManage);
	const createSynced = useCreateSyncedNotebook(projectId);
	const form = useAppForm({
		defaultValues: initialValues,
		validators: schemaValidators(syncedSchema(pullInput)),
		onSubmit: async ({ value }) => {
			try {
				if (value.newBranch === 'yes' && !branchInput.validate(value.repo)) {
					toast.error('Working branch publishing is unavailable for this repository');
					return;
				}
				const data = await createSynced.mutateAsync({
					title: value.title.trim(),
					description: value.title.trim(),
					repo: value.repo.trim(),
					branch: value.branch.trim(),
					root_path: normalizeRootPathInput(value.rootPath) || undefined,
					entry_notebook: value.entryNotebook.trim(),
					sync_mode: value.newBranch === 'yes' ? 'pull' : value.syncMode,
					...(value.newBranch === 'yes' ? { fork: { base_branch: value.branch.trim() } } : {}),
					...(value.baseImage !== DEFAULT_BASE_IMAGE ? { base_image: value.baseImage } : {}),
					...(value.computeProfile !== DEFAULT_COMPUTE_PROFILE
						? { compute_profile: value.computeProfile }
						: {}),
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
					syncMode: value.newBranch === 'yes' ? 'pull' : value.syncMode,
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
	const newBranch = useSelector(form.store, (state) => state.values.newBranch === 'yes');

	return (
		<FormDialog
			form={form}
			isPending={createSynced.isPending}
			isOpen={isOpen}
			onClose={onClose}
			title="Add a git repository"
			width="md"
			submitLabel="Create"
			pendingLabel="Creating..."
		>
			{pullAvailable && canManage && !newBranch && (
				<form.AppField name="syncMode">
					{(f) => (
						<f.RadioGroupField
							label="How content is synced"
							options={[
								{
									value: 'pull',
									label: pullLabel,
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
			{branchInput.available && canManage && (
				<form.AppField name="newBranch">
					{(f) => (
						<f.RadioGroupField
							label="Repository workflow"
							options={[
								{
									value: 'no',
									label: 'Track an existing branch',
									description: 'Import source changes from the repository.',
								},
								{
									value: 'yes',
									label: 'New working branch',
									description: 'Commit edits to a new branch and open a pull request.',
								},
							]}
						/>
					)}
				</form.AppField>
			)}
			{newBranch && (
				<p className="text-xs text-muted-foreground">
					Start from an existing notebook file. Edits are committed only when you choose Save to
					branch.
				</p>
			)}
			<form.AppField name="title">
				{(f) => <f.TextField label="Notebook name" placeholder="my_dashboard" autoFocus />}
			</form.AppField>
			{offersImageChoice && (
				<form.AppField name="baseImage">
					{(f) => (
						<f.RadioGroupField label="Base image" options={baseImageOptions(sandboxImages)} />
					)}
				</form.AppField>
			)}
			{offersComputeChoice && (
				<form.AppField name="computeProfile">
					{(f) => (
						<f.RadioGroupField label="Compute" options={computeProfileOptions(computeProfiles)} />
					)}
				</form.AppField>
			)}
			<form.AppField name="repo">
				{(f) => (
					<f.TextField
						label="Repository"
						placeholder={
							syncMode === 'pull'
								? pullInput.placeholder
								: 'owner/repo or https://gitlab.example.com/group/project'
						}
					/>
				)}
			</form.AppField>
			<form.AppField name="branch">
				{(f) => <f.TextField label={newBranch ? 'New branch from' : 'Branch'} placeholder="main" />}
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
