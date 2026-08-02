import { useState } from 'react';
import { toast } from 'sonner';
import {
	ArrowLeft,
	Braces,
	Database,
	FlaskConical,
	Flame,
	FolderInput,
	HardDrive,
	Library,
	Network,
	Pencil,
	Plus,
	Puzzle,
	SearchX,
	Snowflake,
	Trash2,
	Zap,
} from 'lucide-react';
import {
	Button,
	ComboBox,
	ConfirmDialog,
	DialogModal,
	IconButton,
	SearchField,
	Skeleton,
	TextField,
} from '@/components/ui';
import {
	SchemaForm,
	buildDefaults,
	pruneForSubmit,
	validateValue,
} from '@/components/form/schema-form';
import type { JsonSchemaNode, UiHints } from '@/components/form/schema-form';
import {
	useCreateIntegration,
	useDeleteIntegration,
	useImportIntegration,
	useIntegrationDetailQuery,
	useIntegrationKindsQuery,
	useIntegrationsQuery,
	useProjectPickerQuery,
	useProjectRoleQuery,
	useTestIntegration,
	useUpdateIntegration,
} from '@/api/hooks';
import type { IntegrationsScope } from '@/api/hooks';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { toastError } from '@/lib/errors';
import { filterBySearch } from '@/lib/search';
import type { IntegrationEntry, IntegrationKind, ProjectDetail } from '@/types';

// Mirrors the server's `assertValidIntegrationName` for instant feedback.
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

type IntegrationCategory = IntegrationKind['category'];

const CATEGORY_PRESENTATION: Record<
	IntegrationCategory,
	{
		label: string;
		icon: typeof Database;
		iconClassName: string;
		badgeClassName: string;
	}
> = {
	database: {
		label: 'Database',
		icon: Database,
		iconClassName: 'bg-blue-500/[0.06] text-blue-600 dark:text-blue-300',
		badgeClassName:
			'border-blue-500/10 bg-blue-500/[0.05] text-blue-600 dark:border-blue-400/10 dark:text-blue-300',
	},
	catalog: {
		label: 'Catalog',
		icon: Library,
		iconClassName: 'bg-sky-500/[0.06] text-sky-700 dark:text-sky-300',
		badgeClassName:
			'border-sky-500/10 bg-sky-500/[0.05] text-sky-700 dark:border-sky-400/10 dark:text-sky-300',
	},
	engine: {
		label: 'Engine',
		icon: Zap,
		iconClassName: 'bg-slate-500/[0.06] text-slate-600 dark:text-slate-300',
		badgeClassName:
			'border-slate-500/10 bg-slate-500/[0.05] text-slate-600 dark:border-slate-400/10 dark:text-slate-300',
	},
	storage: {
		label: 'Storage',
		icon: HardDrive,
		iconClassName: 'bg-blue-500/[0.06] text-blue-600 dark:text-blue-300',
		badgeClassName:
			'border-blue-500/10 bg-blue-500/[0.05] text-blue-600 dark:border-blue-400/10 dark:text-blue-300',
	},
	other: {
		label: 'Other',
		icon: Puzzle,
		iconClassName: 'bg-slate-500/[0.06] text-slate-600 dark:text-slate-300',
		badgeClassName:
			'border-slate-500/10 bg-slate-500/[0.05] text-slate-600 dark:border-slate-400/10 dark:text-slate-300',
	},
};

const KIND_ICONS: Record<string, typeof Database> = {
	postgres: Database,
	trino: Network,
	pyspark: Flame,
	custom_env: Braces,
};

const CATEGORY_ORDER = Object.keys(CATEGORY_PRESENTATION) as IntegrationCategory[];

function getKindPresentation(kind: IntegrationKind | undefined) {
	const category = kind?.category ?? 'other';
	const presentation = CATEGORY_PRESENTATION[category];
	const Icon =
		(kind?.kind.startsWith('iceberg_') ? Snowflake : kind && KIND_ICONS[kind.kind]) ??
		presentation.icon;
	return { ...presentation, Icon };
}

type View =
	| { mode: 'list' }
	| { mode: 'catalog' }
	| { mode: 'import' }
	| { mode: 'create'; kind: IntegrationKind }
	| { mode: 'edit'; entry: IntegrationEntry };

export interface ProjectIntegrationsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
}

export function ProjectIntegrationsDialog({
	isOpen,
	onClose,
	project,
}: ProjectIntegrationsDialogProps) {
	return (
		<IntegrationsDialog
			isOpen={isOpen}
			onClose={onClose}
			scope={{ pid: project.id }}
			canManage={project.your_role === 'admin'}
		/>
	);
}

export interface OrgIntegrationsDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

// No client-side gating: only super admins can open this, and the server
// rejects everyone else anyway.
export function OrgIntegrationsDialog({ isOpen, onClose }: OrgIntegrationsDialogProps) {
	return <IntegrationsDialog isOpen={isOpen} onClose={onClose} scope="org" canManage />;
}

function IntegrationsDialog({
	isOpen,
	onClose,
	scope,
	canManage,
}: {
	isOpen: boolean;
	onClose: () => void;
	scope: IntegrationsScope;
	canManage: boolean;
}) {
	const [view, setView] = useState<View>({ mode: 'list' });
	const close = () => {
		onClose();
		setView({ mode: 'list' });
	};
	const kindsQuery = useIntegrationKindsQuery(isOpen);
	const entriesQuery = useIntegrationsQuery(scope, isOpen);
	const kinds = kindsQuery.data;
	const entries = entriesQuery.data;

	const title =
		view.mode === 'catalog'
			? 'Add integration'
			: view.mode === 'import'
				? 'Import integration'
				: view.mode === 'create'
					? `Add ${view.kind.title}`
					: view.mode === 'edit'
						? `Edit ${view.entry.name}`
						: scope === 'org'
							? 'Org integrations'
							: 'Integrations';

	return (
		<DialogModal
			isOpen={isOpen}
			onClose={close}
			title={title}
			width={view.mode === 'list' || view.mode === 'catalog' ? 'xl' : 'lg'}
		>
			<div className="flex flex-col gap-4 text-sm">
				{view.mode !== 'list' && (
					<button
						type="button"
						className="flex w-fit items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() =>
							setView(
								view.mode === 'create' || view.mode === 'import'
									? { mode: 'catalog' }
									: { mode: 'list' },
							)
						}
					>
						<ArrowLeft className="size-3.5" aria-hidden />
						Back
					</button>
				)}

				{/* Query errors also have undefined data, so handle them before the loading branch. */}
				{kindsQuery.isError || entriesQuery.isError ? (
					<p className="text-destructive">
						Could not load integrations. Close this dialog and try again.
					</p>
				) : kinds === undefined || entries === undefined ? (
					<Skeleton className="h-24" />
				) : kinds === null || entries === null ? (
					<p className="text-muted-foreground">Integrations are not enabled on this deployment.</p>
				) : view.mode === 'list' ? (
					<ListView
						scope={scope}
						entries={entries}
						kinds={kinds}
						canManage={canManage}
						onAdd={() => setView({ mode: 'catalog' })}
						onEdit={(entry) => setView({ mode: 'edit', entry })}
					/>
				) : view.mode === 'catalog' ? (
					<CatalogView
						kinds={kinds}
						onPick={(kind) => setView({ mode: 'create', kind })}
						onImport={scope === 'org' ? undefined : () => setView({ mode: 'import' })}
					/>
				) : view.mode === 'import' ? (
					// Unreachable for the org scope: the catalog never offers Import there.
					scope !== 'org' ? (
						<ImportView pid={scope.pid} kinds={kinds} onDone={() => setView({ mode: 'list' })} />
					) : null
				) : view.mode === 'create' ? (
					<EditorView scope={scope} kind={view.kind} onDone={() => setView({ mode: 'list' })} />
				) : (
					<EditorView
						scope={scope}
						kind={kinds.find((k) => k.kind === view.entry.kind)}
						entry={view.entry}
						onDone={() => setView({ mode: 'list' })}
					/>
				)}
			</div>
		</DialogModal>
	);
}

function ListView({
	scope,
	entries,
	kinds,
	canManage,
	onAdd,
	onEdit,
}: {
	scope: IntegrationsScope;
	entries: IntegrationEntry[];
	kinds: IntegrationKind[];
	canManage: boolean;
	onAdd: () => void;
	onEdit: (entry: IntegrationEntry) => void;
}) {
	const [query, setQuery] = useState('');
	const updateIntegration = useUpdateIntegration(scope);
	const deleteIntegration = useDeleteIntegration(scope);
	const confirmDelete = useDialogTarget<IntegrationEntry>();
	// In a project listing, org entries are inherited: visible but managed only
	// through the org dialog. A same-name project integration overrides them.
	const isInherited = (entry: IntegrationEntry) => scope !== 'org' && entry.scope === 'org';
	const kindsByName = new Map(kinds.map((kind) => [kind.kind, kind]));
	const visibleEntries = filterBySearch(entries, query, (entry) => {
		const kind = kindsByName.get(entry.kind);
		return `${entry.name} ${entry.kind} ${kind?.title ?? ''} ${kind?.category ?? ''}`;
	});

	const toggleEnabled = (entry: IntegrationEntry) => {
		updateIntegration.mutate(
			{ id: entry.id, enabled: !entry.enabled },
			{
				onSuccess: () =>
					toast.success(entry.enabled ? `${entry.name} disabled` : `${entry.name} enabled`),
				onError: toastError,
			},
		);
	};

	const handleRemove = () => {
		const target = confirmDelete.target;
		if (!target) return;
		deleteIntegration.mutate(target.id, {
			onSuccess: () => {
				toast.success('Integration deleted');
				confirmDelete.close();
			},
			onError: toastError,
		});
	};

	return (
		<>
			<div className="flex flex-col gap-3 border-b pb-4">
				<div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
					<p className="max-w-3xl text-muted-foreground">
						{scope === 'org'
							? 'Connection config every session in every project receives as env vars and ' +
								'files. A project overrides (or opts out of) an org integration by creating ' +
								'one with the same name.'
							: 'Connection config every session in this project receives as env vars and files. New ' +
								'sessions pick up config changes; running ones keep what they started with.'}
					</p>
					{canManage && (
						<Button variant="primary" onPress={onAdd} className="shrink-0">
							<Plus className="size-4" aria-hidden />
							Add integration
						</Button>
					)}
				</div>
				{entries.length > 0 && (
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
						<SearchField
							aria-label="Search configured integrations"
							placeholder="Search integrations…"
							value={query}
							onChange={setQuery}
							className="w-full sm:max-w-sm"
						/>
						<p className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
							{visibleEntries.length === entries.length
								? `${entries.length} integration${entries.length === 1 ? '' : 's'}`
								: `${visibleEntries.length} of ${entries.length} integrations`}
						</p>
					</div>
				)}
			</div>

			{entries.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center">
					<div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
						<Puzzle className="size-5" aria-hidden />
					</div>
					<div>
						<p className="font-medium">No integrations yet.</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Add a connection to make it available to new project sessions.
						</p>
					</div>
				</div>
			) : visibleEntries.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center">
					<SearchX className="size-5 text-muted-foreground" aria-hidden />
					<div>
						<p className="font-medium">No matching integrations</p>
						<p className="mt-1 text-xs text-muted-foreground">Try a different search term.</p>
					</div>
					<Button variant="ghost" size="sm" onPress={() => setQuery('')}>
						Clear Search
					</Button>
				</div>
			) : (
				<ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
					{visibleEntries.map((entry) => {
						const kind = kindsByName.get(entry.kind);
						const presentation = getKindPresentation(kind);
						const { Icon } = presentation;
						return (
							<li
								key={entry.id}
								data-testid="integration-row"
								className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3.5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
							>
								<span className="flex min-w-0 items-center gap-3">
									<span
										className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${presentation.iconClassName}`}
									>
										<Icon className="size-5" aria-hidden />
									</span>
									<span className="flex min-w-0 flex-col gap-1">
										<span className="flex min-w-0 items-center gap-1.5">
											<code className="truncate text-xs font-medium">{entry.name}</code>
											{!entry.enabled && (
												<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
													disabled
												</span>
											)}
											{isInherited(entry) && (
												<span
													className="rounded-full border border-primary/20 bg-primary/[0.06] px-2 py-0.5 text-[10px] font-medium text-primary"
													title="Managed by your org's super admins; inherited by every project."
												>
													org
												</span>
											)}
											{entry.shadowed && (
												<span
													className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
													title="Overridden by this project's same-name integration."
												>
													overridden
												</span>
											)}
										</span>
										<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
											<span className="truncate">{kind?.title ?? entry.kind}</span>
											<span aria-hidden>·</span>
											<span className="shrink-0 tabular-nums">v{entry.current_version}</span>
										</span>
									</span>
								</span>
								{canManage && !isInherited(entry) && (
									<span className="flex shrink-0 items-center justify-end gap-1 border-t pt-2 sm:border-0 sm:pt-0">
										<Button variant="ghost" size="sm" onPress={() => toggleEnabled(entry)}>
											{entry.enabled ? 'Disable' : 'Enable'}
										</Button>
										<IconButton
											label={`Edit ${entry.name}`}
											tooltip="Edit"
											onPress={() => onEdit(entry)}
										>
											<Pencil className="size-4" aria-hidden />
										</IconButton>
										<IconButton
											label={`Delete ${entry.name}`}
											tooltip="Delete"
											tone="danger"
											onPress={() => confirmDelete.open(entry)}
										>
											<Trash2 className="size-4" aria-hidden />
										</IconButton>
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}

			<ConfirmDialog
				isOpen={confirmDelete.isOpen}
				onClose={confirmDelete.close}
				title="Delete integration"
				description={`Delete "${confirmDelete.target?.name}"? New sessions in ${scope === 'org' ? 'every project' : 'this project'} will no longer receive it.`}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={deleteIntegration.isPending}
				onConfirm={handleRemove}
			/>
		</>
	);
}

function CatalogView({
	kinds,
	onPick,
	onImport,
}: {
	kinds: IntegrationKind[];
	onPick: (kind: IntegrationKind) => void;
	onImport?: () => void;
}) {
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<'all' | IntegrationCategory>('all');
	const categoryCounts = new Map<IntegrationCategory, number>();
	for (const kind of kinds) {
		categoryCounts.set(kind.category, (categoryCounts.get(kind.category) ?? 0) + 1);
	}
	const categories = CATEGORY_ORDER.filter((value) => categoryCounts.has(value));
	const searchedKinds = filterBySearch(
		kinds,
		query,
		(kind) =>
			`${kind.title} ${kind.kind} ${kind.description} ${kind.category} ${kind.requirements.join(' ')}`,
	);
	const visibleKinds =
		category === 'all' ? searchedKinds : searchedKinds.filter((kind) => kind.category === category);

	return (
		<>
			<div className="flex flex-col gap-3 border-b pb-4">
				<div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
					<SearchField
						aria-label="Search integration catalog"
						placeholder="Search by name, category, or package…"
						value={query}
						onChange={setQuery}
						className="w-full sm:max-w-md"
					/>
					{onImport && (
						<Button variant="ghost" onPress={onImport} className="shrink-0">
							<FolderInput className="size-4" aria-hidden />
							Import from another project
						</Button>
					)}
				</div>
				<fieldset className="flex flex-wrap gap-2">
					<legend className="sr-only">Filter integration categories</legend>
					<button
						type="button"
						aria-pressed={category === 'all'}
						onClick={() => setCategory('all')}
						className="rounded-full border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:border-primary/30 data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
						data-active={category === 'all'}
					>
						All <span className="tabular-nums opacity-70">{kinds.length}</span>
					</button>
					{categories.map((value) => {
						const presentation = CATEGORY_PRESENTATION[value];
						const CategoryIcon = presentation.icon;
						return (
							<button
								key={value}
								type="button"
								aria-pressed={category === value}
								onClick={() => setCategory(value)}
								className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${presentation.badgeClassName} ${category === value ? 'ring-1 ring-current' : ''}`}
							>
								<CategoryIcon className="size-3.5" aria-hidden />
								{presentation.label}{' '}
								<span className="tabular-nums opacity-70">{categoryCounts.get(value)}</span>
							</button>
						);
					})}
				</fieldset>
			</div>

			{visibleKinds.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center">
					<SearchX className="size-5 text-muted-foreground" aria-hidden />
					<div>
						<p className="font-medium">No matching integration types</p>
						<p className="mt-1 text-xs text-muted-foreground">Try another search or category.</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onPress={() => {
							setQuery('');
							setCategory('all');
						}}
					>
						Clear Filters
					</Button>
				</div>
			) : (
				<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{visibleKinds.map((kind) => {
						const presentation = getKindPresentation(kind);
						const { Icon } = presentation;
						return (
							<li key={kind.kind} className="min-w-0">
								<button
									type="button"
									data-testid="kind-card"
									onClick={() => onPick(kind)}
									className="group flex h-full w-full flex-col items-start gap-3 rounded-xl border border-input bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-ring hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none"
								>
									<span className="flex w-full items-start justify-between gap-3">
										<span
											className={`flex size-10 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105 motion-reduce:transform-none ${presentation.iconClassName}`}
										>
											<Icon className="size-5" aria-hidden />
										</span>
										<span
											className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${presentation.badgeClassName}`}
										>
											{presentation.label}
										</span>
									</span>
									<span className="flex min-w-0 flex-1 flex-col gap-1.5">
										<span className="text-sm font-semibold">{kind.title}</span>
										<span className="line-clamp-2 text-xs leading-5 text-muted-foreground">
											{kind.description}
										</span>
									</span>
									{kind.requirements.length > 0 && (
										<span className="w-full truncate border-t pt-2.5 text-[11px] text-muted-foreground/80">
											Notebook packages: <code>{kind.requirements.join(', ')}</code>
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}

function ImportView({
	pid,
	kinds,
	onDone,
}: {
	pid: string;
	kinds: IntegrationKind[];
	onDone: () => void;
}) {
	const [projectInput, setProjectInput] = useState('');
	const [sourcePid, setSourcePid] = useState<string>();
	const [sourceEntry, setSourceEntry] = useState<IntegrationEntry>();
	const [name, setName] = useState('');
	const [nameError, setNameError] = useState<string>();
	const projectsQuery = useProjectPickerQuery(true);
	const sourceProject = useProjectRoleQuery(sourcePid);
	const isSourceAdmin = sourceProject.data?.your_role === 'admin';
	const entriesQuery = useIntegrationsQuery({ pid: sourcePid ?? '' }, Boolean(sourcePid));
	const importIntegration = useImportIntegration(pid);
	const kindsByName = new Map(kinds.map((kind) => [kind.kind, kind]));

	const projectOptions = (projectsQuery.data ?? [])
		.filter((p) => p.id !== pid)
		.filter((p) => p.name.toLowerCase().includes(projectInput.trim().toLowerCase()))
		.map((p) => ({ id: p.id, textValue: p.name }));

	// Only the source project's own instances: inherited org entries already
	// reach the destination through inheritance.
	const entries = (entriesQuery.data ?? []).filter((e) => e.scope !== 'org');

	const pickProject = (id: string) => {
		setSourcePid(id);
		setSourceEntry(undefined);
		setProjectInput(projectsQuery.data?.find((p) => p.id === id)?.name ?? id);
	};

	const submit = async () => {
		if (!sourcePid || !sourceEntry) return;
		const trimmed = name.trim();
		if (!NAME_RE.test(trimmed)) {
			setNameError('Lowercase letters, digits, and hyphens; starting with a letter.');
			return;
		}
		setNameError(undefined);
		try {
			await importIntegration.mutateAsync({
				source_project_id: sourcePid,
				source_integration_id: sourceEntry.id,
				name: trimmed,
			});
			toast.success(`Imported ${trimmed}`);
			onDone();
		} catch (err) {
			toastError(err);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<p className="max-w-3xl text-muted-foreground">
				Copy an integration's current config from a project you administer. Secrets are re-encrypted
				for this project; the copy starts its own version history.
			</p>
			<ComboBox
				label="Source project"
				placeholder="Search projects…"
				inputValue={projectInput}
				onInputChange={(value) => {
					setProjectInput(value);
					setSourcePid(undefined);
					setSourceEntry(undefined);
				}}
				options={projectOptions}
				onSelect={pickProject}
				renderOption={(option) => <span className="truncate text-sm">{option.textValue}</span>}
				emptyState="No matching projects"
			/>

			{sourcePid && sourceProject.data && !isSourceAdmin ? (
				<p className="text-muted-foreground">
					You need the <code>admin</code> role on both projects to import an integration.
				</p>
			) : sourcePid && (entriesQuery.isError || sourceProject.isError) ? (
				<p className="text-destructive">Could not load that project's integrations.</p>
			) : sourcePid && entriesQuery.data !== undefined ? (
				entries.length === 0 ? (
					<p className="text-muted-foreground">That project has no integrations of its own.</p>
				) : (
					<fieldset className="flex flex-col gap-2">
						<legend className="pb-1 text-xs font-medium text-muted-foreground">
							Integration to copy
						</legend>
						<ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{entries.map((entry) => {
								const kind = kindsByName.get(entry.kind);
								const presentation = getKindPresentation(kind);
								const { Icon } = presentation;
								const selected = sourceEntry?.id === entry.id;
								return (
									<li key={entry.id}>
										<button
											type="button"
											data-testid="import-source-row"
											aria-pressed={selected}
											onClick={() => {
												setSourceEntry(entry);
												setName(entry.name);
												setNameError(undefined);
											}}
											className={`flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-primary/40 ring-1 ring-primary/30' : 'border-input'}`}
										>
											<span
												className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${presentation.iconClassName}`}
											>
												<Icon className="size-4.5" aria-hidden />
											</span>
											<span className="flex min-w-0 flex-col">
												<code className="truncate text-xs font-medium">{entry.name}</code>
												<span className="truncate text-xs text-muted-foreground">
													{kind?.title ?? entry.kind}
												</span>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</fieldset>
				)
			) : sourcePid ? (
				<Skeleton className="h-16" />
			) : null}

			{sourceEntry && (
				<form
					className="flex flex-col gap-4 border-t pt-4"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<TextField
						label="Name in this project"
						value={name}
						onChange={setName}
						error={nameError}
					/>
					<div className="flex justify-end">
						<Button type="submit" variant="primary" isDisabled={importIntegration.isPending}>
							{importIntegration.isPending ? 'Importing…' : 'Import integration'}
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}

function EditorView({
	scope,
	kind,
	entry,
	onDone,
}: {
	scope: IntegrationsScope;
	kind: IntegrationKind | undefined;
	entry?: IntegrationEntry;
	onDone: () => void;
}) {
	const editing = entry !== undefined;
	const detailQuery = useIntegrationDetailQuery(scope, entry?.id);
	const detail = detailQuery.data?.detail;
	if (!kind) {
		// A stored custom kind may be unavailable after a deployment change.
		return <p className="text-muted-foreground">This integration's kind is not available.</p>;
	}
	if (editing && detailQuery.isError) {
		return <p className="text-destructive">Could not load this integration. Go back and retry.</p>;
	}
	if (editing && detail === undefined) return <Skeleton className="h-40" />;
	return (
		<EditorForm
			key={detail?.id ?? kind.kind}
			scope={scope}
			kind={kind}
			initialName={detail?.name ?? ''}
			initialConfig={
				(detail?.config as Record<string, unknown> | undefined) ??
				(buildDefaults(kind.json_schema as JsonSchemaNode) as Record<string, unknown>)
			}
			entryId={detail?.id}
			etag={detailQuery.data?.etag}
			onDone={onDone}
		/>
	);
}

function EditorForm({
	scope,
	kind,
	initialName,
	initialConfig,
	entryId,
	etag,
	onDone,
}: {
	scope: IntegrationsScope;
	kind: IntegrationKind;
	initialName: string;
	initialConfig: Record<string, unknown>;
	entryId?: string;
	etag?: string;
	onDone: () => void;
}) {
	const editing = entryId !== undefined;
	const schema = kind.json_schema as JsonSchemaNode;
	const hints = kind.ui_hints as UiHints;
	const [name, setName] = useState(initialName);
	const [config, setConfig] = useState(initialConfig);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const createIntegration = useCreateIntegration(scope);
	const updateIntegration = useUpdateIntegration(scope);
	const testIntegration = useTestIntegration(scope);
	const isPending = createIntegration.isPending || updateIntegration.isPending;

	const submit = async () => {
		const nextErrors = validateValue(schema, config);
		if (!NAME_RE.test(name.trim())) {
			nextErrors.__name = 'Lowercase letters, digits, and hyphens; starting with a letter.';
		}
		setErrors(nextErrors);
		if (Object.keys(nextErrors).length > 0) return;
		const body = pruneForSubmit(schema, config) as Record<string, unknown>;
		try {
			if (entryId !== undefined) {
				await updateIntegration.mutateAsync({
					id: entryId,
					etag,
					name: name.trim(),
					config: body,
				});
				toast.success('Integration updated');
			} else {
				await createIntegration.mutateAsync({ kind: kind.kind, name: name.trim(), config: body });
				toast.success('Integration added');
			}
			onDone();
		} catch (err) {
			toastError(err);
		}
	};

	const handleTest = async () => {
		try {
			// Editing tests the SAVED config ({id}); unsaved edits aren't probed —
			// a keep-marker has no value to test with until it is saved.
			const result = await testIntegration.mutateAsync(
				entryId !== undefined
					? { id: entryId }
					: { kind: kind.kind, config: pruneForSubmit(schema, config) as Record<string, unknown> },
			);
			if (result.ok) {
				toast.success(
					`Connection OK${result.latency_ms !== undefined ? ` (${result.latency_ms} ms)` : ''}${
						result.details ? ` — ${result.details}` : ''
					}`,
				);
			} else {
				toast.error(`Connection failed${result.details ? ` — ${result.details}` : ''}`);
			}
		} catch (err) {
			toastError(err);
		}
	};

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<TextField
				label="Name"
				placeholder="prod"
				value={name}
				onChange={setName}
				error={errors.__name}
			/>
			<SchemaForm
				schema={schema}
				hints={hints}
				value={config}
				onChange={setConfig}
				errors={errors}
				editing={editing}
			/>
			<div className="flex justify-end gap-2 border-t pt-4">
				{kind.supports_test && (
					<Button
						type="button"
						variant="ghost"
						isDisabled={testIntegration.isPending}
						onPress={() => void handleTest()}
					>
						<FlaskConical className="size-4" aria-hidden />
						{testIntegration.isPending
							? 'Testing…'
							: editing
								? 'Test saved config'
								: 'Test connection'}
					</Button>
				)}
				<Button type="submit" variant="primary" isDisabled={isPending}>
					{isPending ? 'Saving…' : editing ? 'Save changes' : 'Add integration'}
				</Button>
			</div>
		</form>
	);
}
