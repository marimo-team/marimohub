import { useState } from 'react';
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
import {
	Button,
	ConfirmDialog,
	CopyField,
	DialogModal,
	TextField,
	WriteOnceWarning,
} from '@/components/ui';
import { useNotebookQuery, useRotateSyncToken, useUpdateGitSource } from '@/api/hooks';
import { ServerSyncRow } from '@/components/Notebook/SyncNow';
import {
	ENTRY_NOTEBOOK_HINT,
	ENTRY_NOTEBOOK_PATTERN,
	isRepoInput,
	REPO_INPUT_HINT,
} from '@/lib/git';
import { DOCS_SYNCING_URL } from '@/lib/links';
import { formatRelative } from '@/lib/time';

interface SyncSettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebookId: string;
	title: string;
	syncUrl?: string;
	canManage: boolean;
	canOperate: boolean;
	initialToken?: string;
}

const settingsSchema = z.object({
	repo: requiredText('Repository').refine(isRepoInput, REPO_INPUT_HINT),
	branch: requiredText('Branch'),
	rootPath: optionalText(),
	entryNotebook: requiredText('Notebook file').regex(ENTRY_NOTEBOOK_PATTERN, ENTRY_NOTEBOOK_HINT),
});

const EMPTY = { repo: '', branch: '', rootPath: '', entryNotebook: '' };

function activeSourceLabel(source: {
	repo: string;
	branch: string;
	root_path: string;
	entry_notebook: string;
	commit: string | null;
}) {
	const commit = source.commit ? ` at ${source.commit.slice(0, 12)}` : '';
	const file = source.root_path
		? `${source.root_path}/${source.entry_notebook}`
		: source.entry_notebook;
	return `${source.repo} · ${source.branch} · ${file}${commit}`;
}

export function SyncSettingsDialog({
	isOpen,
	onClose,
	projectId,
	notebookId,
	title,
	syncUrl,
	canManage,
	canOperate,
	initialToken,
}: SyncSettingsDialogProps) {
	const detail = useNotebookQuery(projectId, notebookId, { staleTime: 0 });
	const updateSource = useUpdateGitSource(projectId);
	const rotateToken = useRotateSyncToken(projectId);
	const [token, setToken] = useState(initialToken);
	const [confirmRotate, setConfirmRotate] = useState(false);
	const source = detail.data?.source.type === 'git' ? detail.data.source : undefined;
	const isPull = source?.sync_mode === 'pull';
	const desired = source?.pending_config ?? source;
	const values = desired
		? {
				repo: desired.repo,
				branch: desired.branch,
				rootPath: desired.root_path,
				entryNotebook: desired.entry_notebook,
			}
		: EMPTY;

	const form = useAppForm({
		defaultValues: values,
		validators: schemaValidators(settingsSchema),
		onSubmit: async ({ value }) => {
			if (!source || !canManage) return;
			try {
				const data = await updateSource.mutateAsync({
					notebookId,
					repo: value.repo.trim(),
					branch: value.branch.trim(),
					root_path: value.rootPath.trim(),
					entry_notebook: value.entryNotebook.trim(),
				});
				toast.success(
					data.source.pending_config
						? `Sync settings saved; current content stays active until the next ${isPull ? 'Sync now' : 'matching push'}`
						: 'Sync settings saved',
				);
				onClose();
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(form, isOpen && !!source, values);

	const credentials = (
		<div className="flex flex-col gap-3 border-t pt-4">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 className="text-sm font-medium">Sync credentials</h3>
					<p className="text-xs text-muted-foreground">
						Used by an external pusher such as a CI workflow.{' '}
						<a
							href={DOCS_SYNCING_URL}
							target="_blank"
							rel="noreferrer"
							className="text-primary underline-offset-2 hover:underline"
						>
							Learn more
						</a>
						.
					</p>
				</div>
				{canOperate && (
					<Button type="button" size="sm" onPress={() => setConfirmRotate(true)}>
						Rotate token
					</Button>
				)}
			</div>
			{syncUrl && <CopyField label="Sync URL" value={syncUrl} />}
			{token ? (
				<>
					<CopyField label="Sync token" value={token} />
					<WriteOnceWarning />
				</>
			) : (
				<p className="rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					The token is shown only when the notebook is created or its token is rotated.
					{canOperate ? ' Rotate it to mint a new one.' : ''}
				</p>
			)}
		</div>
	);

	const serverSync = (
		<ServerSyncRow
			projectId={projectId}
			notebookId={notebookId}
			source={source}
			enabled={canOperate}
			className="rounded-md border border-input bg-muted/40 px-3 py-2"
		/>
	);

	const sourceStatus = source ? (
		source.pending_config ? (
			<p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
				Changes are pending. The notebook continues serving{' '}
				<span className="font-medium text-foreground">{activeSourceLabel(source)}</span> until{' '}
				{isPull ? 'Sync now applies the settings above.' : 'a push matches the settings above.'}
			</p>
		) : (
			<p className="text-xs text-muted-foreground">
				{source.last_synced_at
					? `Last synced ${formatRelative(source.last_synced_at)} at ${source.commit?.slice(0, 12)}`
					: 'Not synced yet'}
			</p>
		)
	) : detail.isError ? (
		<p className="text-sm text-destructive">{detail.error.message}</p>
	) : (
		<p className="text-sm text-muted-foreground">Loading sync settings...</p>
	);

	const dialog = canManage ? (
		<FormDialog
			form={form}
			isPending={updateSource.isPending}
			requireDirty
			submitDisabled={!source}
			isOpen={isOpen}
			onClose={onClose}
			title={`Sync settings — ${title}`}
			submitLabel="Save"
			pendingLabel="Saving..."
			cancelLabel="Close"
			width="lg"
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<form.AppField name="repo">
					{(f) => (
						<f.TextField
							label="Repository"
							placeholder="owner/repo or https://gitlab.example.com/group/project"
							isDisabled={!source}
						/>
					)}
				</form.AppField>
				<form.AppField name="branch">
					{(f) => <f.TextField label="Branch" placeholder="main" isDisabled={!source} />}
				</form.AppField>
				{!isPull && (
					<form.AppField name="rootPath">
						{(f) => (
							<f.TextField
								label="Folder in repo (optional)"
								placeholder="apps"
								isDisabled={!source}
							/>
						)}
					</form.AppField>
				)}
				<form.AppField name="entryNotebook">
					{(f) => (
						<f.TextField label="Notebook file" placeholder="dashboard.py" isDisabled={!source} />
					)}
				</form.AppField>
			</div>
			{sourceStatus}
			{serverSync}
			{source?.sync_mode === 'push' && credentials}
		</FormDialog>
	) : (
		<DialogModal isOpen={isOpen} onClose={onClose} title={`Sync settings — ${title}`} width="lg">
			<div className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<TextField label="Repository" value={values.repo} isReadOnly />
					<TextField label="Branch" value={values.branch} isReadOnly />
					{!isPull && <TextField label="Folder in repo" value={values.rootPath} isReadOnly />}
					<TextField label="Notebook file" value={values.entryNotebook} isReadOnly />
				</div>
				{sourceStatus}
				{serverSync}
				{source?.sync_mode === 'push' && credentials}
				<div className="flex justify-end pt-2">
					<Button variant="primary" onPress={onClose}>
						Done
					</Button>
				</div>
			</div>
		</DialogModal>
	);

	return (
		<>
			{dialog}
			{canOperate && source?.sync_mode === 'push' && (
				<ConfirmDialog
					isOpen={confirmRotate}
					onClose={() => setConfirmRotate(false)}
					title="Rotate Sync Token"
					description="The current token stops working immediately and any pusher using it must be updated."
					confirmLabel="Rotate"
					pendingLabel="Rotating..."
					isPending={rotateToken.isPending}
					onConfirm={() => {
						rotateToken.mutate(notebookId, {
							onSuccess: (data) => {
								setToken(data.sync_token);
								setConfirmRotate(false);
								toast.success(`Rotated sync token for "${title}"`);
							},
						});
					}}
				/>
			)}
		</>
	);
}
