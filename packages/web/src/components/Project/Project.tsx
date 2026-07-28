import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileTrigger } from 'react-aria-components';
import { toast } from 'sonner';
import { z } from 'zod';
import {
	AppWindow,
	ArrowLeft,
	ChevronDown,
	Container,
	Copy,
	Download,
	FileText,
	FolderArchive,
	GitBranch,
	History,
	KeyRound,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	Power,
	RefreshCw,
	SearchX,
	Trash2,
	Upload,
	Users,
	X,
} from 'lucide-react';
import {
	Button,
	DropdownMenu,
	IconButton,
	IconLink,
	RowLink,
	SearchField,
	ConfirmDialog,
	EmptyState,
	ListContainer,
	PageContainer,
	PageHeader,
	SessionStatusDot,
	UserLabel,
} from '@/components/ui';
import {
	FormDialog,
	ConfirmDialog as FormConfirmDialog,
	optionalText,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import {
	useNotebooksQuery,
	useCreateNotebook,
	useDuplicateNotebook,
	useDeleteNotebook,
	useDownloadNotebookFile,
	useDownloadWorkspace,
	useProjectQuery,
	useUpdateProject,
	useDeleteProject,
	useProjectSessionsQuery,
	useRestartApp,
	useStopSession,
	useUsersQuery,
	useCapabilitiesQuery,
	useRotateSyncToken,
} from '@/api/hooks';
import { AppSessionIndicator } from './AppSessionIndicator';
import { ProjectMembersDialog } from './ProjectMembersDialog';
import { ProjectSecretsDialog } from './ProjectSecretsDialog';
import { RenameNotebookDialog } from '@/components/Notebook/RenameNotebookDialog';
import { ChangeBaseImageDialog } from '@/components/Notebook/ChangeBaseImageDialog';
import { baseImageOptions, DEFAULT_BASE_IMAGE } from '@/components/Notebook/baseImage';
import { SyncedNotebookDialog } from '@/components/Notebook/SyncedNotebookDialog';
import type { SyncedNotebookCreated } from '@/components/Notebook/SyncedNotebookDialog';
import { SyncKeysDialog } from '@/components/Notebook/SyncKeysDialog';
import { VersionHistoryDialog } from '@/components/Notebook/VersionHistoryDialog';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useDisclosure } from '@/hooks/useDisclosure';
import { useSearchField } from '@/hooks/useSearchField';
import { toastError } from '@/lib/errors';
import { filterBySearch } from '@/lib/search';
import { formatRelative } from '@/lib/time';
import { syncUrl } from '@/lib/links';
import { appConnectionHint, sessionsByNotebook } from '@/lib/sessions';
import type { DropdownMenuOption } from '@/components/ui';
import type { NotebookEntry, Session } from '@/types';

/**
 * The tag/status chips for a notebook row: its tags if any, otherwise a
 * noteworthy lifecycle status. The unremarkable `active` (nearly every notebook)
 * is hidden, and a tagless `active` notebook shows nothing.
 */
function notebookBadges(nb: NotebookEntry): string[] {
	if (nb.tags.length > 0) return nb.tags;
	return nb.status === 'active' ? [] : [nb.status];
}

const MAX_UPLOAD_BYTES = 1_000_000;

const projectSchema = z.object({
	name: requiredText('Project name'),
	description: optionalText(),
});
const notebookNameSchema = z.object({ name: requiredText('Notebook name'), baseImage: z.string() });

const NEW_NOTEBOOK_CODE = (name: string) =>
	`import marimo\n\napp = marimo.App()\n\n\n@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)\n\n\n@app.cell(hide_code=True)\ndef _(mo):\n    mo.md(r"""# ${name}""")\n    return\n\n\nif __name__ == "__main__":\n    app.run()\n`;

export function Project() {
	const { pid } = useParams<{ pid: string }>();
	const navigate = useNavigate();
	const search = useSearchField();

	// Dialogs acting on a row use useDialogTarget; plain ones use useDisclosure.
	const uploadModal = useDisclosure();
	// When set, a `.py` file's contents seed the new notebook instead of the template.
	const [uploadedCode, setUploadedCode] = useState<string | null>(null);
	const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
	const deleteModal = useDialogTarget<NotebookEntry>();
	const renameModal = useDialogTarget<NotebookEntry>();
	const baseImageModal = useDialogTarget<NotebookEntry>();
	const historyModal = useDialogTarget<NotebookEntry>();
	const syncedCreateModal = useDisclosure();
	const syncKeys = useDialogTarget<{ notebookId: string; title: string; token?: string }>();
	const rotateModal = useDialogTarget<NotebookEntry>();
	const stopModal = useDialogTarget<{ notebook: NotebookEntry; session: Session }>();
	// The shared app's stop/restart confirm — separate from the edit-kernel stop
	// so the copy can warn about disconnecting other people.
	const appModal = useDialogTarget<{
		action: 'stop' | 'restart';
		notebook: NotebookEntry;
		session: Session;
	}>();
	// Project-level edit/delete (this page's project, not the notebooks).
	const editProjectModal = useDisclosure();
	const deleteProjectModal = useDisclosure();
	const secretsModal = useDisclosure();
	const membersModal = useDisclosure();

	const { data: notebooks } = useNotebooksQuery(pid!);
	const { data: project } = useProjectQuery(pid!);
	const { data: sessions, isLoading: sessionsLoading } = useProjectSessionsQuery(pid!);
	const createNotebook = useCreateNotebook(pid!);
	const duplicateNotebook = useDuplicateNotebook(pid!);
	const deleteNotebook = useDeleteNotebook(pid!);
	const downloadNotebookFile = useDownloadNotebookFile(pid!);
	const downloadWorkspace = useDownloadWorkspace(pid!);
	const updateProject = useUpdateProject();
	const deleteProject = useDeleteProject();
	const { data: capabilities } = useCapabilitiesQuery();
	// The picker only appears when there is an actual choice to make.
	const sandboxImages = capabilities?.sandbox_images ?? [];
	const offersImageChoice = sandboxImages.length > 1;
	const rotateSyncToken = useRotateSyncToken(pid!);
	// Re-bound each render to the notebook in the stop dialog; only fired on confirm.
	const stopSession = useStopSession(pid!, stopModal.target?.notebook.id ?? '');
	const stopAppSession = useStopSession(pid!, appModal.target?.notebook.id ?? '');
	const restartAppSession = useRestartApp(pid!, appModal.target?.notebook.id ?? '');
	// Per-session actions render from the server-evaluated `session.can` grants.
	// Start has no session to carry grants, so it derives from the evaluated
	// admission row in capabilities. The server enforces all of it regardless.
	const canStartApps =
		project.your_role !== 'viewer' || (capabilities?.viewer_session_modes ?? []).includes('app');

	const editProjectForm = useAppForm({
		defaultValues: { name: project.name, description: project.description },
		validators: schemaValidators(projectSchema),
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			try {
				await updateProject.mutateAsync({
					projectId: pid!,
					name,
					description: value.description.trim(),
				});
				toast.success(`Updated project "${name}"`);
				editProjectModal.close();
			} catch (err) {
				toastError(err);
			}
		},
	});
	useSeedOnOpen(editProjectForm, editProjectModal.isOpen, {
		name: project.name,
		description: project.description,
	});

	const deleteProjectForm = useAppForm({
		defaultValues: { confirmName: '' },
		// Empty message: a mismatch only gates the button, it shouldn't flash a red
		// error while the user is still typing the name.
		validators: schemaValidators(
			z.object({ confirmName: z.literal(project.name, { error: () => '' }) }),
		),
		onSubmit: async () => {
			try {
				await deleteProject.mutateAsync(pid!);
				toast.success(`Deleted "${project.name}"`);
				void navigate('/');
			} catch (err) {
				toastError(err);
			}
		},
	});
	useSeedOnOpen(deleteProjectForm, deleteProjectModal.isOpen, { confirmName: '' });

	const createNotebookForm = useAppForm({
		defaultValues: { name: '', baseImage: DEFAULT_BASE_IMAGE },
		validators: schemaValidators(notebookNameSchema),
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			try {
				await createNotebook.mutateAsync({
					title: name,
					description: name,
					code: uploadedCode ?? NEW_NOTEBOOK_CODE(name),
					...(value.baseImage !== DEFAULT_BASE_IMAGE ? { base_image: value.baseImage } : {}),
				});
				toast.success(`Created "${name}"`);
				closeCreateModal();
			} catch (err) {
				toastError(err);
			}
		},
	});
	useSeedOnOpen(createNotebookForm, uploadModal.isOpen, {
		name: '',
		baseImage: DEFAULT_BASE_IMAGE,
	});

	const handleSaveSecrets = (enabled: boolean) => {
		updateProject.mutate(
			{ projectId: pid!, federation: { enabled } },
			{
				onSuccess: () => {
					toast.success(
						enabled ? 'Federated bucket access enabled' : 'Federated bucket access disabled',
					);
					secretsModal.close();
				},
				onError: toastError,
			},
		);
	};

	// Map each notebook to its "most alive" session so a row shows the strongest state.
	const sessionByNotebook = useMemo(() => sessionsByNotebook(sessions), [sessions]);

	// Resolve every author (and session starter) shown on the page in one batch,
	// so opaque user ids render as names.
	const { data: users, isLoading: usersLoading } = useUsersQuery([
		...(notebooks ?? []).map((nb) => nb.author),
		...(sessions ?? []).map((s) => s.user_id),
	]);

	const closeCreateModal = () => {
		setUploadedCode(null);
		setUploadedFileName(null);
		uploadModal.close();
	};

	const handleFileSelect = async (files: FileList | null) => {
		const file = files?.[0];
		if (!file) return;
		if (file.size > MAX_UPLOAD_BYTES) {
			toast.error('File is too large (max 1 MB).');
			return;
		}
		const text = await file.text();
		setUploadedCode(text);
		setUploadedFileName(file.name);
		if (!createNotebookForm.getFieldValue('name').trim()) {
			createNotebookForm.setFieldValue('name', file.name.replace(/\.py$/, ''));
		}
	};

	const clearUploadedFile = () => {
		setUploadedCode(null);
		setUploadedFileName(null);
	};

	const handleDelete = () => {
		const nb = deleteModal.target;
		if (!nb) return;

		deleteNotebook.mutate(nb.id, {
			onSuccess: () => {
				toast.success(`Deleted "${nb.title}"`);
				deleteModal.close();
			},
			onError: toastError,
		});
	};

	const handleDuplicate = (nb: NotebookEntry) => {
		toast.promise(duplicateNotebook.mutateAsync({ notebookId: nb.id }), {
			loading: `Duplicating "${nb.title}"...`,
			success: `Duplicated "${nb.title}"`,
			error: (err: Error) => err.message,
		});
	};

	const handleDownloadFile = (nb: NotebookEntry) => {
		downloadNotebookFile.mutate({ notebookId: nb.id, title: nb.title }, { onError: toastError });
	};

	const handleDownloadWorkspace = (nb: NotebookEntry) => {
		toast.promise(downloadWorkspace.mutateAsync({ notebookId: nb.id, title: nb.title }), {
			loading: `Preparing workspace for "${nb.title}"...`,
			success: 'Workspace downloaded',
			error: (err: Error) => err.message,
		});
	};

	const handleStop = () => {
		const stop = stopModal.target;
		if (!stop) return;

		stopSession.mutate(stop.session.session_id, {
			onSuccess: () => {
				toast.success(`Stopped "${stop.notebook.title}"`);
				stopModal.close();
			},
			onError: toastError,
		});
	};

	const handleAppAction = () => {
		if (!appModal.target) return;
		const { action, notebook, session } = appModal.target;
		const mutation = action === 'stop' ? stopAppSession : restartAppSession;
		mutation.mutate(session.session_id, {
			onSuccess: () => {
				toast.success(
					action === 'stop'
						? `Stopped the app for "${notebook.title}"`
						: `Restarted the app for "${notebook.title}"`,
				);
				appModal.close();
			},
			onError: toastError,
		});
	};

	const handleSyncedCreated = (result: SyncedNotebookCreated) => {
		syncedCreateModal.close();
		syncKeys.open({ notebookId: result.notebookId, title: result.title, token: result.token });
	};

	const handleRotateToken = () => {
		if (!rotateModal.target) return;
		const { id, title } = rotateModal.target;
		rotateSyncToken.mutate(id, {
			onSuccess: (data) => {
				toast.success(`Rotated sync token for "${title}"`);
				rotateModal.close();
				syncKeys.open({ notebookId: id, title, token: data.sync_token });
			},
			onError: toastError,
		});
	};

	const notebookActions = (nb: NotebookEntry): DropdownMenuOption[] => [
		{ id: 'rename', label: 'Rename', icon: <Pencil className="size-4" /> },
		{ id: 'duplicate', label: 'Duplicate', icon: <Copy className="size-4" /> },
		// The shared app: start it, open the running one, or stop it — each item
		// gated by the caller's server-evaluated grants on the live session.
		// Derived from the 5s session poll, so an item can be ~5s stale: a racing
		// "Run as app" harmlessly attaches (create reuses per mode); a racing
		// "Stop app" 404s into a toast.
		...(() => {
			const app = sessionByNotebook.get(nb.id)?.app;
			if (!app) {
				return canStartApps
					? [{ id: 'run-app', label: 'Run as app', icon: <Play className="size-4" /> }]
					: [];
			}
			return [
				...(app.can?.attach
					? [{ id: 'open-app', label: 'Open app', icon: <AppWindow className="size-4" /> }]
					: []),
				...(app.can?.stop
					? [
							{
								id: 'stop-app',
								label: 'Stop app',
								icon: <Power className="size-4" />,
								danger: true,
							},
						]
					: []),
			];
		})(),
		...(offersImageChoice
			? [{ id: 'change-image', label: 'Change base image', icon: <Container className="size-4" /> }]
			: []),
		{ id: 'history', label: 'Version history', icon: <History className="size-4" /> },
		...(nb.source_type === 'git'
			? [
					{ id: 'sync-keys', label: 'Sync keys', icon: <KeyRound className="size-4" /> },
					{
						id: 'rotate-token',
						label: 'Rotate sync token',
						icon: <RefreshCw className="size-4" />,
					},
				]
			: []),
		{ id: 'download-file', label: 'Download notebook file', icon: <Download className="size-4" /> },
		{
			id: 'download-workspace',
			label: 'Download workspace',
			icon: <FolderArchive className="size-4" />,
		},
		{ id: 'delete', label: 'Delete', icon: <Trash2 className="size-4" />, danger: true },
	];

	const filteredNotebooks = filterBySearch(notebooks, search.query, (nb) => nb.title);

	return (
		<PageContainer>
			<title>{`${project.name} · marimohub`}</title>
			<PageHeader
				actions={
					<div className="flex items-center gap-1.5">
						<Button variant="primary" onPress={uploadModal.open}>
							<Plus className="size-4" />
							New Notebook
						</Button>
						<DropdownMenu
							label="More create options"
							icon={<ChevronDown className="size-4" />}
							triggerClassName="size-9 rounded-md border border-input bg-background hover:border-primary hover:text-primary"
							options={[
								{
									id: 'synced',
									label: 'Sync from git repo',
									icon: <GitBranch className="size-4" />,
								},
							]}
							onAction={(key) => {
								if (key === 'synced') syncedCreateModal.open();
							}}
						/>
					</div>
				}
			>
				<IconLink
					to="/"
					label="Back to projects"
					tooltip="Back to projects"
					variant="bordered"
					size="md"
				>
					<ArrowLeft className="size-4" />
				</IconLink>
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1">
						<h1 className="mr-1 truncate text-xl font-semibold tracking-tight" title={project.name}>
							{project.name}
						</h1>
						{/* Subtle project-level actions — uncommon, so kept low-emphasis. */}
						<IconButton label="Members" tooltip="Members" onPress={membersModal.open}>
							<Users className="size-4" />
						</IconButton>
						<IconButton
							label="Project secrets"
							tooltip="Project secrets"
							onPress={secretsModal.open}
						>
							<KeyRound className="size-4" />
						</IconButton>
						<IconButton label="Edit project" tooltip="Edit project" onPress={editProjectModal.open}>
							<Pencil className="size-4" />
						</IconButton>
						<IconButton
							label="Delete project"
							tooltip="Delete project"
							tone="danger"
							onPress={deleteProjectModal.open}
						>
							<Trash2 className="size-4" />
						</IconButton>
					</div>
					{project.description && project.description !== project.name && (
						<p className="truncate text-sm text-muted-foreground" title={project.description}>
							{project.description}
						</p>
					)}
				</div>
			</PageHeader>

			<div className="mb-4">
				<SearchField
					aria-label="Search notebooks"
					placeholder="Search notebooks..."
					value={search.query}
					onChange={search.setQuery}
					inputRef={search.inputRef}
				/>
			</div>

			{filteredNotebooks.length === 0 ? (
				search.query ? (
					<EmptyState
						icon={<SearchX />}
						message={`No notebooks matching "${search.query}"`}
						description="Try a different search term."
					/>
				) : (
					<EmptyState
						icon={<FileText />}
						message="No notebooks yet"
						description="Create a notebook from scratch or upload an existing .py file."
						action={
							<Button variant="default" onPress={uploadModal.open}>
								<Plus className="size-4" />
								Create your first notebook
							</Button>
						}
					/>
				)
			) : (
				<ListContainer>
					{filteredNotebooks.map((nb) => {
						const badges = notebookBadges(nb);
						const live = sessionByNotebook.get(nb.id);
						return (
							<RowLink
								key={nb.id}
								testId="notebook-row"
								to={`/projects/${pid}/notebooks/${nb.id}`}
								state={{ title: nb.title }}
								label={nb.title}
								contentClassName="items-center justify-between gap-3 py-3.5"
								actions={
									<>
										{/* Primary shutdown stays edit-only: the inline Power button
										    never targets the shared app (dropdown/popover do). */}
										{live?.edit && (
											<IconButton
												label="Shut down kernel"
												tooltip="Shut down kernel"
												tone="danger"
												onPress={() => stopModal.open({ notebook: nb, session: live.edit! })}
											>
												<Power className="size-4" />
											</IconButton>
										)}
										<DropdownMenu
											label="Notebook actions"
											icon={<MoreHorizontal className="size-4" />}
											triggerClassName="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
											options={notebookActions(nb)}
											onAction={(key) => {
												if (key === 'rename') renameModal.open(nb);
												else if (key === 'duplicate') handleDuplicate(nb);
												else if (key === 'run-app' || key === 'open-app')
													void navigate(`/projects/${pid}/notebooks/${nb.id}/app`, {
														state: { title: nb.title },
													});
												else if (key === 'stop-app') {
													const app = sessionByNotebook.get(nb.id)?.app;
													if (app) appModal.open({ action: 'stop', notebook: nb, session: app });
												} else if (key === 'change-image') baseImageModal.open(nb);
												else if (key === 'history') historyModal.open(nb);
												else if (key === 'sync-keys')
													syncKeys.open({ notebookId: nb.id, title: nb.title });
												else if (key === 'rotate-token') rotateModal.open(nb);
												else if (key === 'download-file') handleDownloadFile(nb);
												else if (key === 'download-workspace') handleDownloadWorkspace(nb);
												else if (key === 'delete') deleteModal.open(nb);
											}}
										/>
									</>
								}
							>
								<div className="flex min-w-0 items-center gap-3">
									<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
										{nb.source_type === 'git' ? (
											<GitBranch className="size-4" />
										) : (
											<FileText className="size-4" />
										)}
									</span>
									<span className="truncate text-sm font-medium">{nb.title}</span>
									{badges.map((badge) => (
										<span
											key={badge}
											className="shrink-0 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary max-md:hidden"
										>
											{badge}
										</span>
									))}
								</div>
								<div className="flex shrink-0 items-center gap-3">
									{live?.app && (
										<AppSessionIndicator
											session={live.app}
											canControl={!!live.app.can?.stop}
											canOpen={!!live.app.can?.attach}
											editActive={!!live.edit}
											onStop={() =>
												appModal.open({ action: 'stop', notebook: nb, session: live.app! })
											}
											onRestart={() =>
												appModal.open({ action: 'restart', notebook: nb, session: live.app! })
											}
										/>
									)}
									<SessionStatusDot session={live?.edit} loading={sessionsLoading} />
									<span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
										<span className="text-muted-foreground/70">by</span>
										<UserLabel
											user={users?.[nb.author]}
											fallbackId={nb.author}
											loading={usersLoading}
											className="max-w-[8rem]"
										/>
									</span>
									<time
										dateTime={nb.updated_at}
										title={new Date(nb.updated_at).toLocaleString()}
										className="text-xs tabular-nums text-muted-foreground"
									>
										{formatRelative(nb.updated_at)}
									</time>
								</div>
							</RowLink>
						);
					})}
				</ListContainer>
			)}

			<FormDialog
				form={createNotebookForm}
				isPending={createNotebook.isPending}
				isOpen={uploadModal.isOpen}
				onClose={closeCreateModal}
				title="Create New Notebook"
				submitLabel="Create"
				pendingLabel="Creating..."
			>
				<createNotebookForm.AppField name="name">
					{(f) => <f.TextField label="Notebook Name" placeholder="my_analysis" autoFocus />}
				</createNotebookForm.AppField>
				{offersImageChoice && (
					<createNotebookForm.AppField name="baseImage">
						{(f) => (
							<f.RadioGroupField label="Base image" options={baseImageOptions(sandboxImages)} />
						)}
					</createNotebookForm.AppField>
				)}
				<div className="flex flex-col gap-1.5">
					<span className="text-xs font-medium text-muted-foreground">
						Start from a file <span className="font-normal">(optional)</span>
					</span>
					{uploadedFileName ? (
						<div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
							<FileText className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate">{uploadedFileName}</span>
							<IconButton label="Remove file" onPress={clearUploadedFile} className="ml-auto">
								<X className="size-4" />
							</IconButton>
						</div>
					) : (
						<FileTrigger
							acceptedFileTypes={['.py']}
							onSelect={(files) => void handleFileSelect(files)}
						>
							<Button variant="default" size="sm">
								<Upload className="size-4" />
								Upload .py file
							</Button>
						</FileTrigger>
					)}
				</div>
			</FormDialog>

			{renameModal.target && (
				<RenameNotebookDialog
					isOpen={renameModal.isOpen}
					onClose={renameModal.close}
					projectId={pid!}
					notebook={renameModal.target}
				/>
			)}

			{baseImageModal.target && (
				<ChangeBaseImageDialog
					isOpen={baseImageModal.isOpen}
					onClose={baseImageModal.close}
					projectId={pid!}
					notebook={baseImageModal.target}
				/>
			)}

			{/* Mounted only while open so history is fetched on demand and selection resets. */}
			{historyModal.target && (
				<VersionHistoryDialog
					isOpen
					onClose={historyModal.close}
					projectId={pid!}
					notebook={historyModal.target}
					canRestore={project.your_role !== 'viewer'}
				/>
			)}

			<SyncedNotebookDialog
				isOpen={syncedCreateModal.isOpen}
				onClose={syncedCreateModal.close}
				projectId={pid!}
				onCreated={handleSyncedCreated}
			/>

			{syncKeys.target && (
				<SyncKeysDialog
					isOpen={syncKeys.isOpen}
					onClose={syncKeys.close}
					title={syncKeys.target.title}
					syncUrl={syncUrl(pid!, syncKeys.target.notebookId)}
					token={syncKeys.target.token}
				/>
			)}

			<ConfirmDialog
				isOpen={rotateModal.isOpen}
				onClose={rotateModal.close}
				title="Rotate Sync Token"
				description={`Rotate the sync token for "${rotateModal.target?.title}"? The current token stops working immediately and any pusher using it must be updated.`}
				confirmLabel="Rotate"
				pendingLabel="Rotating..."
				isPending={rotateSyncToken.isPending}
				onConfirm={handleRotateToken}
			/>

			<ConfirmDialog
				isOpen={deleteModal.isOpen}
				onClose={deleteModal.close}
				title="Delete Notebook"
				description={`Are you sure you want to delete "${deleteModal.target?.title}"? This action cannot be undone.`}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={deleteNotebook.isPending}
				onConfirm={handleDelete}
			/>

			<ConfirmDialog
				isOpen={stopModal.isOpen}
				onClose={stopModal.close}
				title="Shut Down Kernel"
				description={`Shut down the running kernel for "${stopModal.target?.notebook.title}"? Saved work is preserved; the sandbox is stopped and can be started again later.`}
				confirmLabel="Shut Down"
				pendingLabel="Stopping..."
				isPending={stopSession.isPending}
				onConfirm={handleStop}
			/>

			<ConfirmDialog
				isOpen={appModal.isOpen}
				onClose={appModal.close}
				title={appModal.target?.action === 'restart' ? 'Restart App' : 'Stop App'}
				description={
					appModal.target?.action === 'restart'
						? `Restart the app for "${appModal.target.notebook.title}"? It will come back serving the latest saved version — anyone using it now will be disconnected and must reopen it.${appConnectionHint(appModal.target.session)}`
						: `Stop the app for "${appModal.target?.notebook.title}"? Anyone using it will be disconnected.${appConnectionHint(appModal.target?.session)}`
				}
				confirmLabel={appModal.target?.action === 'restart' ? 'Restart' : 'Stop App'}
				pendingLabel={appModal.target?.action === 'restart' ? 'Restarting...' : 'Stopping...'}
				isPending={stopAppSession.isPending || restartAppSession.isPending}
				onConfirm={handleAppAction}
			/>

			<FormDialog
				form={editProjectForm}
				isPending={updateProject.isPending}
				isOpen={editProjectModal.isOpen}
				onClose={editProjectModal.close}
				title="Edit Project"
				submitLabel="Save"
				pendingLabel="Saving..."
			>
				<editProjectForm.AppField name="name">
					{(f) => <f.TextField label="Project Name" placeholder="My Analysis" autoFocus />}
				</editProjectForm.AppField>
				<editProjectForm.AppField name="description">
					{(f) => <f.TextField label="Description" placeholder="Optional description" />}
				</editProjectForm.AppField>
			</FormDialog>

			{/* Mounted only while open so the member list is fetched on demand, not with the page. */}
			{membersModal.isOpen && (
				<ProjectMembersDialog isOpen onClose={membersModal.close} project={project} />
			)}

			<ProjectSecretsDialog
				isOpen={secretsModal.isOpen}
				onClose={secretsModal.close}
				project={project}
				available={capabilities?.federation.available ?? false}
				isPending={updateProject.isPending}
				onSave={handleSaveSecrets}
			/>

			<FormConfirmDialog
				form={deleteProjectForm}
				isPending={deleteProject.isPending}
				isOpen={deleteProjectModal.isOpen}
				onClose={deleteProjectModal.close}
				title="Delete Project"
				description={`Are you sure you want to delete "${project.name}"? All notebooks in this project will be deleted. This action cannot be undone.`}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
			>
				<deleteProjectForm.AppField name="confirmName">
					{(f) => (
						<f.TextField
							label={`Type "${project.name}" to confirm`}
							placeholder={project.name}
							autoFocus
						/>
					)}
				</deleteProjectForm.AppField>
			</FormConfirmDialog>
		</PageContainer>
	);
}
