import { lazy, Suspense, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileTrigger } from 'react-aria-components';
import { toast } from 'sonner';
import { z } from 'zod';
import {
	AppWindow,
	ArrowLeft,
	Bell,
	Camera,
	ChevronDown,
	Container,
	Copy,
	Cpu,
	Database,
	Download,
	FileDown,
	FileText,
	FolderArchive,
	FolderSearch,
	GitBranch,
	History,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	Power,
	RefreshCw,
	Settings2,
	Trash2,
	Upload,
	Users,
	X,
} from 'lucide-react';
import {
	Button,
	Chip,
	DropdownMenu,
	IconButton,
	IconLink,
	LinkButton,
	RowLink,
	ConfirmDialog,
	EmptyState,
	ListFilters,
	ListResults,
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
	useDownloadOutputsHtml,
	useDownloadWorkspace,
	useProjectQuery,
	useUpdateProject,
	useDeleteProject,
	useProjectSessionsQuery,
	useRestartApp,
	useRestartSession,
	useStopSession,
	useUsersQuery,
	useCapabilitiesQuery,
	useIntegrationKindsQuery,
	useIntegrationsQuery,
} from '@/api/hooks';
import { supportsIntegrationDataPage } from '@/lib/integrationNotebook';
import { AppSessionIndicator } from './AppSessionIndicator';
import { ProjectMembersDialog } from './ProjectMembersDialog';
import { ProjectEnvironmentDialog } from './ProjectEnvironmentDialog';
import { ProjectAlertsDialog } from './ProjectAlertsDialog';
import { RenameNotebookDialog } from '@/components/Notebook/RenameNotebookDialog';
import { ChangeBaseImageDialog } from '@/components/Notebook/ChangeBaseImageDialog';
import { baseImageOptions, DEFAULT_BASE_IMAGE } from '@/components/Notebook/baseImage';
import { ChangeComputeProfileDialog } from '@/components/Notebook/ChangeComputeProfileDialog';
import {
	computeProfileOptions,
	DEFAULT_COMPUTE_PROFILE,
} from '@/components/Notebook/computeProfiles';
import { GitSourcePopover } from '@/components/Notebook/GitSourcePopover';
import { SyncedNotebookDialog } from '@/components/Notebook/SyncedNotebookDialog';
import type { SyncedNotebookCreated } from '@/components/Notebook/SyncedNotebookDialog';
import { SyncSettingsDialog } from '@/components/Notebook/SyncSettingsDialog';
import { VersionHistoryDialog } from '@/components/Notebook/VersionHistoryDialog';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useDisclosure } from '@/hooks/useDisclosure';
import { useListFilters } from '@/hooks/useListFilters';
import { formatRelative } from '@/lib/time';
import { syncUrl } from '@/lib/links';
import { sessionConnectionHint, sessionsByNotebook } from '@/lib/sessions';
import { canManageProject } from '@/lib/roles';
import type { DropdownMenuOption } from '@/components/ui';
import type { NotebookEntry, ResolvedUser, Session } from '@/types';

const WorkspaceBrowserDialog = lazy(
	() => import('@/components/WorkspaceBrowser/WorkspaceBrowserDialog'),
);

/** Keep non-active lifecycle state visible even when the notebook has user tags. */
function notebookBadges(nb: NotebookEntry): string[] {
	const badges = [...nb.tags];
	if (nb.status !== 'active' && !badges.includes(nb.status)) badges.push(nb.status);
	return badges;
}

const MAX_UPLOAD_BYTES = 1_000_000;

const NOTEBOOK_STATUS_FILTERS = [
	{ value: 'active', label: 'Active' },
	{ value: 'draft', label: 'Draft' },
	{ value: 'archived', label: 'Archived' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

const NOTEBOOK_HISTORY_ACTIONS: DropdownMenuOption[] = [
	{ id: 'view-snapshot', label: 'View static outputs', icon: <Camera className="size-4" /> },
	{ id: 'history', label: 'Version history', icon: <History className="size-4" /> },
];

const NOTEBOOK_EXPORT_ACTIONS: DropdownMenuOption[] = [
	{
		id: 'download-file',
		label: 'Download notebook file',
		icon: <Download className="size-4" />,
	},
	{
		id: 'download-outputs',
		label: 'Download outputs (HTML)',
		icon: <FileDown className="size-4" />,
	},
	{
		id: 'download-workspace',
		label: 'Download workspace',
		icon: <FolderArchive className="size-4" />,
	},
];

function groupedMenuOptions(groups: DropdownMenuOption[][]): DropdownMenuOption[] {
	const options: DropdownMenuOption[] = [];
	for (const group of groups) {
		if (group.length === 0) continue;
		if (options.length === 0) options.push(...group);
		else options.push({ ...group[0], separatorBefore: true }, ...group.slice(1));
	}
	return options;
}

const DELETED_NOTEBOOK_ACTIONS = groupedMenuOptions([
	NOTEBOOK_HISTORY_ACTIONS,
	NOTEBOOK_EXPORT_ACTIONS,
]);

interface DeletedNotebookRowProps {
	notebook: NotebookEntry;
	user: ResolvedUser | undefined;
	usersLoading: boolean;
	onAction: (key: string) => void;
}

function DeletedNotebookRow({ notebook, user, usersLoading, onAction }: DeletedNotebookRowProps) {
	return (
		<div
			data-testid="notebook-row"
			className="flex items-center border-b border-l-2 border-l-transparent bg-muted/20 last:border-b-0"
		>
			<div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3.5">
				<div className="flex min-w-0 items-center gap-3">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						{notebook.source_type === 'git' ? (
							<GitBranch className="size-4" aria-hidden="true" />
						) : (
							<FileText className="size-4" aria-hidden="true" />
						)}
					</span>
					<span className="truncate text-sm font-medium" title={notebook.title}>
						{notebook.title}
					</span>
					{notebookBadges(notebook).map((badge) => (
						<Chip key={badge} className={badge === 'deleted' ? undefined : 'max-md:hidden'}>
							{badge}
						</Chip>
					))}
				</div>
				<div className="flex shrink-0 items-center gap-3">
					<span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
						<span className="text-muted-foreground/70">by</span>
						<UserLabel
							user={user}
							fallbackId={notebook.author}
							loading={usersLoading}
							className="max-w-[8rem]"
						/>
					</span>
					<time
						dateTime={notebook.updated_at}
						title={new Date(notebook.updated_at).toLocaleString()}
						className="text-xs tabular-nums text-muted-foreground"
					>
						{formatRelative(notebook.updated_at)}
					</time>
				</div>
			</div>
			<div className="relative flex shrink-0 items-center pr-2">
				<DropdownMenu
					label={`Historical actions for ${notebook.title}`}
					icon={<MoreHorizontal className="size-4" />}
					options={DELETED_NOTEBOOK_ACTIONS}
					onAction={onAction}
				/>
			</div>
		</div>
	);
}

const projectSchema = z.object({
	name: requiredText('Project name'),
	description: optionalText(),
});
const notebookNameSchema = z.object({
	name: requiredText('Notebook name'),
	baseImage: z.string(),
	computeProfile: z.string(),
});

const NEW_NOTEBOOK_CODE = (name: string) => {
	const heading = JSON.stringify(`# ${name}`);
	return `import marimo\n\napp = marimo.App(width="medium", sql_output="native")\n\n\n@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)\n\n\n@app.cell(hide_code=True)\ndef _(mo):\n    mo.md(${heading})\n    return\n\n\nif __name__ == "__main__":\n    app.run()\n`;
};

function useProjectContent() {
	const { pid } = useParams<{ pid: string }>();
	const navigate = useNavigate();
	const { filters, setFilters, filtersActive } = useListFilters(NOTEBOOK_STATUS_FILTERS);

	// Dialogs acting on a row use useDialogTarget; plain ones use useDisclosure.
	const uploadModal = useDisclosure();
	// When set, a `.py` file's contents seed the new notebook instead of the template.
	const [uploadedCode, setUploadedCode] = useState<string | null>(null);
	const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
	const deleteModal = useDialogTarget<NotebookEntry>();
	const renameModal = useDialogTarget<NotebookEntry>();
	const baseImageModal = useDialogTarget<NotebookEntry>();
	const computeProfileModal = useDialogTarget<NotebookEntry>();
	const historyModal = useDialogTarget<NotebookEntry>();
	const workspaceBrowser = useDialogTarget<NotebookEntry>();
	const syncedCreateModal = useDisclosure();
	const syncSettings = useDialogTarget<{ notebookId: string; title: string; token?: string }>();
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
	const environmentModal = useDisclosure();
	const membersModal = useDisclosure();
	const alertsModal = useDisclosure();

	const {
		data: notebooks = [],
		isPending: notebooksLoading,
		isFetching: notebooksFetching,
	} = useNotebooksQuery(pid!, filters);
	const { data: project } = useProjectQuery(pid!);
	const { data: sessions, isLoading: sessionsLoading } = useProjectSessionsQuery(pid!);
	const createNotebook = useCreateNotebook(pid!);
	const duplicateNotebook = useDuplicateNotebook(pid!);
	const deleteNotebook = useDeleteNotebook(pid!);
	const downloadNotebookFile = useDownloadNotebookFile(pid!);
	const downloadOutputsHtml = useDownloadOutputsHtml(pid!);
	const downloadWorkspace = useDownloadWorkspace(pid!);
	const updateProject = useUpdateProject();
	const deleteProject = useDeleteProject();
	const { data: capabilities } = useCapabilitiesQuery();
	const canManage = canManageProject(project.your_role);
	const canOperateSource = project.your_role !== null && project.your_role !== 'viewer';
	const sandboxImages = capabilities?.sandbox_images ?? [];
	const offersImageChoice = sandboxImages.length > 1;
	const computeProfiles = capabilities?.compute_profiles ?? [];
	const canChooseComputeProfile =
		capabilities?.compute_profile_override === 'editors' && project.your_role !== 'viewer';
	const offersComputeChoice = canChooseComputeProfile && computeProfiles.length > 1;
	// Re-bound each render to the notebook in the stop dialog; only fired on confirm.
	const stopSession = useStopSession(pid!, stopModal.target?.notebook.id ?? '');
	const stopAppSession = useStopSession(pid!, appModal.target?.notebook.id ?? '');
	const restartAppSession = useRestartApp(pid!, appModal.target?.notebook.id ?? '');
	const restartComputeSession = useRestartSession(pid!);
	// Per-session actions render from the server-evaluated `session.can` grants.
	// Start has no session to carry grants, so it derives from the evaluated
	// admission row in capabilities. The server enforces all of it regardless.
	const canStartApps =
		project.your_role !== 'viewer' || (capabilities?.viewer_session_modes ?? []).includes('app');

	const dataBrowserAvailable =
		(capabilities?.data_browser?.available ?? false) && project.your_role !== 'viewer';
	const projectAlertsAvailable = (capabilities?.project_alerts?.available ?? false) && canManage;
	const { data: integrationKinds } = useIntegrationKindsQuery(dataBrowserAvailable);
	const { data: projectIntegrations } = useIntegrationsQuery({ pid: pid! }, dataBrowserAvailable);
	const dataIntegrations = useMemo(() => {
		const kindsByName = new Map((integrationKinds ?? []).map((kind) => [kind.kind, kind]));
		return (projectIntegrations ?? []).filter(
			(entry) =>
				entry.enabled &&
				!entry.shadowed &&
				supportsIntegrationDataPage(kindsByName.get(entry.kind)),
		);
	}, [integrationKinds, projectIntegrations]);

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
			} catch {
				return;
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
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(deleteProjectForm, deleteProjectModal.isOpen, { confirmName: '' });

	const createNotebookForm = useAppForm({
		defaultValues: {
			name: '',
			baseImage: DEFAULT_BASE_IMAGE,
			computeProfile: DEFAULT_COMPUTE_PROFILE,
		},
		validators: schemaValidators(notebookNameSchema),
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			try {
				await createNotebook.mutateAsync({
					title: name,
					description: name,
					code: uploadedCode ?? NEW_NOTEBOOK_CODE(name),
					...(value.baseImage !== DEFAULT_BASE_IMAGE ? { base_image: value.baseImage } : {}),
					...(value.computeProfile !== DEFAULT_COMPUTE_PROFILE
						? { compute_profile: value.computeProfile }
						: {}),
				});
				toast.success(`Created "${name}"`);
				closeCreateModal();
			} catch {
				return;
			}
		},
	});
	useSeedOnOpen(createNotebookForm, uploadModal.isOpen, {
		name: '',
		baseImage: DEFAULT_BASE_IMAGE,
		computeProfile: DEFAULT_COMPUTE_PROFILE,
	});

	const handleSaveCloudAccess = async (enabled: boolean) => {
		await updateProject.mutateAsync({ projectId: pid!, federation: { enabled } });
		toast.success(enabled ? 'Federated cloud access enabled' : 'Federated cloud access disabled');
	};

	// Map each notebook to its "most alive" session so a row shows the strongest state.
	const sessionByNotebook = useMemo(() => sessionsByNotebook(sessions), [sessions]);
	const computeTarget = computeProfileModal.target;
	const computeLive = computeTarget ? sessionByNotebook.get(computeTarget.id) : undefined;
	const computeRestartSession = computeLive?.edit?.can?.stop
		? computeLive.edit
		: computeLive?.app?.can?.stop
			? computeLive.app
			: undefined;

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
		});
	};

	const handleDuplicate = (nb: NotebookEntry) => {
		// Loading feedback only — the error toast comes from the global mutation cache.
		const loadingToast = toast.loading(`Duplicating "${nb.title}"...`);
		duplicateNotebook.mutate(
			{ notebookId: nb.id },
			{
				onSuccess: () => toast.success(`Duplicated "${nb.title}"`, { id: loadingToast }),
				onError: () => toast.dismiss(loadingToast),
			},
		);
	};

	const handleDownloadFile = (nb: NotebookEntry) => {
		downloadNotebookFile.mutate({ notebookId: nb.id, title: nb.title });
	};

	const handleDownloadOutputs = (nb: NotebookEntry) => {
		downloadOutputsHtml.mutate({ notebookId: nb.id, title: nb.title });
	};

	const handleDownloadWorkspace = (nb: NotebookEntry) => {
		const loadingToast = toast.loading(`Preparing workspace for "${nb.title}"...`);
		downloadWorkspace.mutate(
			{ notebookId: nb.id, title: nb.title },
			{
				onSuccess: () => toast.success('Workspace downloaded', { id: loadingToast }),
				onError: () => toast.dismiss(loadingToast),
			},
		);
	};

	const handleStop = () => {
		const stop = stopModal.target;
		if (!stop) return;

		stopSession.mutate(stop.session.session_id, {
			onSuccess: () => {
				toast.success(`Stopped "${stop.notebook.title}"`);
				stopModal.close();
			},
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
		});
	};

	const handleComputeRestart = () => {
		if (!computeTarget || !computeRestartSession) return;
		if (computeRestartSession.mode === 'app') {
			appModal.open({
				action: 'restart',
				notebook: computeTarget,
				session: computeRestartSession,
			});
			return;
		}
		void restartComputeSession
			.mutateAsync({
				notebookId: computeTarget.id,
				sessionId: computeRestartSession.session_id,
			})
			.then(() => toast.success(`Restarted the session for "${computeTarget.title}"`))
			.catch(() => {});
	};

	const handleSyncedCreated = (result: SyncedNotebookCreated) => {
		syncedCreateModal.close();
		if (result.syncMode === 'push') {
			syncSettings.open({
				notebookId: result.notebookId,
				title: result.title,
				token: result.token,
			});
		}
	};

	const handleNotebookAction = (nb: NotebookEntry, key: string, stoppableEdit?: Session) => {
		if (key === 'rename') renameModal.open(nb);
		else if (key === 'duplicate') handleDuplicate(nb);
		else if (key === 'stop-kernel' && stoppableEdit)
			stopModal.open({ notebook: nb, session: stoppableEdit });
		else if (key === 'run-app' || key === 'open-app')
			void navigate(`/projects/${pid}/notebooks/${nb.id}/app`, {
				state: { title: nb.title },
			});
		else if (key === 'stop-app') {
			const app = sessionByNotebook.get(nb.id)?.app;
			if (app) appModal.open({ action: 'stop', notebook: nb, session: app });
		} else if (key === 'view-snapshot')
			void navigate(`/projects/${pid}/notebooks/${nb.id}/snapshot`, {
				state: { title: nb.title },
			});
		else if (key === 'change-image') baseImageModal.open(nb);
		else if (key === 'change-compute') computeProfileModal.open(nb);
		else if (key === 'history') historyModal.open(nb);
		else if (key === 'browse-files') workspaceBrowser.open(nb);
		else if (key === 'sync-settings') syncSettings.open({ notebookId: nb.id, title: nb.title });
		else if (key === 'download-file') handleDownloadFile(nb);
		else if (key === 'download-outputs') handleDownloadOutputs(nb);
		else if (key === 'download-workspace') handleDownloadWorkspace(nb);
		else if (key === 'delete') deleteModal.open(nb);
	};

	const notebookActions = (nb: NotebookEntry): DropdownMenuOption[] => {
		const live = sessionByNotebook.get(nb.id);
		const app = live?.app;
		// Session polling can leave these actions about five seconds stale. Starting
		// an app is idempotent, while a raced stop is surfaced by the existing toast.
		const runtimeActions: DropdownMenuOption[] = [
			...(live?.edit?.can?.stop
				? [
						{
							id: 'stop-kernel',
							label: 'Shut down kernel',
							icon: <Power className="size-4" />,
							danger: true,
						},
					]
				: []),
			...(!app
				? canStartApps
					? [{ id: 'run-app', label: 'Run as app', icon: <Play className="size-4" /> }]
					: []
				: [
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
					]),
		];

		const groups: DropdownMenuOption[][] = [
			[
				{ id: 'rename', label: 'Rename', icon: <Pencil className="size-4" /> },
				{ id: 'duplicate', label: 'Duplicate', icon: <Copy className="size-4" /> },
			],
			runtimeActions,
			[
				{ id: 'browse-files', label: 'Browse files', icon: <FolderSearch className="size-4" /> },
				...(offersImageChoice
					? [
							{
								id: 'change-image',
								label: 'Change base image',
								icon: <Container className="size-4" />,
							},
						]
					: []),
				...(offersComputeChoice
					? [
							{
								id: 'change-compute',
								label: 'Change compute…',
								icon: <Cpu className="size-4" />,
							},
						]
					: []),
				...(nb.source_type === 'git'
					? [
							{
								id: 'sync-settings',
								label: 'Sync settings',
								icon: <RefreshCw className="size-4" />,
							},
						]
					: []),
				...NOTEBOOK_HISTORY_ACTIONS,
			],
			NOTEBOOK_EXPORT_ACTIONS,
			[{ id: 'delete', label: 'Delete', icon: <Trash2 className="size-4" />, danger: true }],
		];

		return groupedMenuOptions(groups);
	};

	return (
		<PageContainer>
			<title>{`${project.name} · marimohub`}</title>
			<PageHeader
				actions={
					<div className="flex items-center gap-1.5">
						{dataBrowserAvailable && dataIntegrations.length > 0 && (
							<LinkButton to={`/projects/${pid}/data`} aria-label="Browse data">
								<Database className="size-4" />
								<span className="max-sm:hidden">Browse data</span>
							</LinkButton>
						)}
						<Button variant="primary" onPress={uploadModal.open}>
							<Plus className="size-4" />
							New Notebook
						</Button>
						{canManage ? (
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
						) : null}
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
						<IconButton label="Project access" tooltip="Project access" onPress={membersModal.open}>
							<Users className="size-4" />
						</IconButton>
						<IconButton
							label="Environment & cloud access"
							tooltip="Environment & cloud access"
							onPress={environmentModal.open}
						>
							<Settings2 className="size-4" />
						</IconButton>
						{projectAlertsAvailable && (
							<IconButton
								label="Project alerts"
								tooltip="Project alerts"
								onPress={alertsModal.open}
							>
								<Bell className="size-4" />
							</IconButton>
						)}
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

			<ListFilters
				label="Filter notebooks"
				itemName="notebook"
				values={filters}
				statuses={NOTEBOOK_STATUS_FILTERS}
				resultCount={notebooks.length}
				resultsId="notebook-results"
				isLoading={notebooksLoading}
				isFetching={notebooksFetching}
				onChange={setFilters}
			/>

			<ListResults
				count={notebooks.length}
				emptyState={
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
				}
				isFetching={notebooksFetching}
				isFiltered={filtersActive}
				isLoading={notebooksLoading}
				itemName="notebook"
				onReset={() => setFilters({})}
				resultsId="notebook-results"
			>
				{notebooks.map((nb) => {
					if (nb.status === 'deleted') {
						return (
							<DeletedNotebookRow
								key={nb.id}
								notebook={nb}
								user={users?.[nb.author]}
								usersLoading={usersLoading}
								onAction={(key) => handleNotebookAction(nb, key)}
							/>
						);
					}

					const badges = notebookBadges(nb);
					const live = sessionByNotebook.get(nb.id);
					const stoppableEdit = live?.edit?.can?.stop ? live.edit : undefined;
					return (
						<RowLink
							key={nb.id}
							testId="notebook-row"
							to={`/projects/${pid}/notebooks/${nb.id}`}
							state={{ title: nb.title }}
							label={nb.title}
							contentClassName="items-center justify-between gap-3 py-3.5"
							leading={
								nb.source_type === 'git' ? (
									<GitSourcePopover
										projectId={pid!}
										notebookId={nb.id}
										canSync={project.your_role !== 'viewer'}
										triggerClassName="shrink-0 cursor-pointer rounded-lg"
										trigger={
											<span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
												<GitBranch className="size-4" />
											</span>
										}
									/>
								) : undefined
							}
							actions={
								<>
									{/* Inline shutdown is edit-only; app controls live in the menu. */}
									{stoppableEdit && (
										<IconButton
											label="Shut down kernel"
											tooltip="Shut down kernel"
											tone="danger"
											onPress={() => stopModal.open({ notebook: nb, session: stoppableEdit })}
										>
											<Power className="size-4" />
										</IconButton>
									)}
									<DropdownMenu
										label={`Notebook actions for ${nb.title}`}
										icon={<MoreHorizontal className="size-4" />}
										triggerClassName="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
										options={notebookActions(nb)}
										onAction={(key) => handleNotebookAction(nb, key, stoppableEdit)}
									/>
								</>
							}
						>
							<div className="flex min-w-0 items-center gap-3">
								{nb.source_type !== 'git' && (
									<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
										<FileText className="size-4" />
									</span>
								)}
								<span className="truncate text-sm font-medium">{nb.title}</span>
								{badges.map((badge) => (
									<Chip key={badge} className="max-md:hidden">
										{badge}
									</Chip>
								))}
							</div>
							<div className="flex shrink-0 items-center gap-3">
								{live?.app && (
									<AppSessionIndicator
										session={live.app}
										canControl={!!live.app.can?.stop}
										canOpen={!!live.app.can?.attach}
										editActive={!!live.persistentEdit}
										profiles={computeProfiles}
										allowComputeOverride={capabilities?.compute_profile_override === 'editors'}
										selectedProfileName={nb.compute_profile}
										onStop={() =>
											appModal.open({ action: 'stop', notebook: nb, session: live.app! })
										}
										onRestart={() =>
											appModal.open({ action: 'restart', notebook: nb, session: live.app! })
										}
									/>
								)}
								<SessionStatusDot
									session={live?.edit}
									loading={sessionsLoading}
									profiles={computeProfiles}
									selectedProfileName={
										canChooseComputeProfile ? nb.compute_profile : computeProfiles[0]?.name
									}
								/>
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
			</ListResults>

			<FormDialog
				form={createNotebookForm}
				isPending={createNotebook.isPending}
				isOpen={uploadModal.isOpen}
				onClose={closeCreateModal}
				title="Create New Notebook"
				submitLabel="Create"
				pendingLabel="Creating..."
				width="lg"
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
				{offersComputeChoice && (
					<createNotebookForm.AppField name="computeProfile">
						{(field) => (
							<field.RadioGroupField
								label="Compute"
								options={computeProfileOptions(computeProfiles)}
							/>
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

			{computeProfileModal.target && (
				<ChangeComputeProfileDialog
					isOpen={computeProfileModal.isOpen}
					onClose={computeProfileModal.close}
					projectId={pid!}
					notebook={computeProfileModal.target}
					restartAction={
						computeRestartSession
							? {
									label:
										computeRestartSession.mode === 'app'
											? 'Restart app'
											: computeLive?.app?.can?.stop
												? 'Restart edit session'
												: 'Restart session',
									onRestart: handleComputeRestart,
								}
							: undefined
					}
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

			{canManage ? (
				<SyncedNotebookDialog
					isOpen={syncedCreateModal.isOpen}
					onClose={syncedCreateModal.close}
					projectId={pid!}
					onCreated={handleSyncedCreated}
				/>
			) : null}

			{syncSettings.target && (
				<SyncSettingsDialog
					isOpen={syncSettings.isOpen}
					onClose={syncSettings.close}
					projectId={pid!}
					notebookId={syncSettings.target.notebookId}
					title={syncSettings.target.title}
					syncUrl={syncUrl(pid!, syncSettings.target.notebookId)}
					canManage={canManage}
					canOperate={canOperateSource}
					initialToken={syncSettings.target.token}
				/>
			)}

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
						? `Restart the app for "${appModal.target.notebook.title}"? It will come back serving the latest saved version — anyone using it now will be disconnected and must reopen it.${sessionConnectionHint(appModal.target.session)}`
						: `Stop the app for "${appModal.target?.notebook.title}"? Anyone using it will be disconnected.${sessionConnectionHint(appModal.target?.session)}`
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

			{environmentModal.isOpen && (
				<ProjectEnvironmentDialog
					isOpen
					onClose={environmentModal.close}
					project={project}
					integrationsAvailable={capabilities?.integrations?.available ?? false}
					cloudAccessAvailable={capabilities?.federation.available ?? false}
					isPending={updateProject.isPending}
					onSaveCloudAccess={handleSaveCloudAccess}
				/>
			)}

			{workspaceBrowser.isOpen && workspaceBrowser.target ? (
				<Suspense fallback={null}>
					<WorkspaceBrowserDialog
						isOpen
						onClose={workspaceBrowser.close}
						projectId={pid!}
						notebookId={workspaceBrowser.target.id}
						notebookTitle={workspaceBrowser.target.title}
					/>
				</Suspense>
			) : null}

			{alertsModal.isOpen && capabilities?.project_alerts && (
				<ProjectAlertsDialog
					isOpen
					onClose={alertsModal.close}
					projectId={pid!}
					selectableKinds={capabilities.project_alerts.selectable_kinds}
					maxDestinations={capabilities.project_alerts.max_destinations}
				/>
			)}

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

export function Project() {
	return useProjectContent();
}
