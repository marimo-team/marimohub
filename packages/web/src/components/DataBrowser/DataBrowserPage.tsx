/* oxlint-disable jsx-a11y/prefer-tag-over-role -- output cannot contain this status's paragraphs */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	Database,
	Folder,
	RefreshCw,
	Table2,
} from 'lucide-react';
import {
	Button,
	Chip,
	EmptyState,
	IconLink,
	SearchField,
	Skeleton,
	TextField,
} from '@/components/ui';
import {
	refreshBrowseQueries,
	useBrowseCapabilityQuery,
	useBrowseNamespacesQuery,
	useBrowseTableSchemaQuery,
	useBrowseTablePreview,
	useBrowseTablesQuery,
	useCapabilitiesQuery,
	useIntegrationKindsQuery,
	useIntegrationsQuery,
	useProjectQuery,
} from '@/api/hooks';
import { BRAND_ICONS } from '@/components/Project/brandIcons';
import {
	objectBrowseCapability,
	supportsObjectBrowse,
	supportsTableBrowse,
	tableBrowseCapability,
} from '@/lib/integrationBrowse';
import { integrationNotebookInfo, supportsIntegrationDataPage } from '@/lib/integrationNotebook';
import { formatRelative } from '@/lib/time';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { ApiRequestError } from '@/api/client';
import type { IntegrationEntry, IntegrationKind } from '@/types';
import { NotebookSnippet, OpenInNotebookButton } from './NotebookActions';
import { ObjectBrowser } from './ObjectBrowser';
import { TabularPreviewGrid } from './TabularPreviewGrid';

const SqlWorkspace = lazy(() => import('./SqlWorkspace'));

/** Namespace parts join with U+001F in the `ns` query param, so dots round-trip. */
const NS_JOIN = '\u001f';

const splitNs = (value: string | null): string[] => (value ? value.split(NS_JOIN) : []);

const countFormatter = new Intl.NumberFormat();

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
	let value = bytes;
	let unit = -1;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

interface Selection {
	namespace: string[];
	table: string;
}

/** The set plus every ancestor of `ns`; returns `prev` unchanged when there is nothing to add. */
function expandedWithAncestry(
	prev: Set<string>,
	iid: string | undefined,
	ns: string | null,
): Set<string> {
	const parts = splitNs(ns);
	if (parts.length === 0) return prev;
	const next = new Set(prev);
	for (let i = 1; i <= parts.length; i++) {
		next.add(`${iid}:${parts.slice(0, i).join(NS_JOIN)}`);
	}
	return next;
}

/**
 * Full-page, deep-linkable browser over the project's integrations:
 * `/projects/:pid/data/:iid?ns=…&table=…&q=…`. The tree is lazy and paged;
 * selection and search live in the URL so a view can be shared or restored.
 */
export default function DataBrowserPage() {
	const { pid, iid } = useParams<{ pid: string; iid?: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [searchParams, setSearchParams] = useSearchParams();
	const [refreshing, setRefreshing] = useState(false);

	const { data: project } = useProjectQuery(pid!);
	const { data: capabilities } = useCapabilitiesQuery();
	const available =
		(capabilities?.data_browser?.available ?? false) && project.your_role !== 'viewer';
	const { data: kinds } = useIntegrationKindsQuery(available);
	const { data: entries } = useIntegrationsQuery({ pid: pid! }, available);

	const kindsByName = useMemo(() => new Map((kinds ?? []).map((k) => [k.kind, k])), [kinds]);
	const dataIntegrations = useMemo(
		() =>
			(entries ?? []).filter(
				(entry) =>
					entry.enabled &&
					!entry.shadowed &&
					supportsIntegrationDataPage(kindsByName.get(entry.kind)),
			),
		[entries, kindsByName],
	);

	const query = searchParams.get('q') ?? '';
	const selection: Selection | null = useMemo(() => {
		const table = searchParams.get('table');
		const ns = splitNs(searchParams.get('ns'));
		return table && ns.length > 0 ? { namespace: ns, table } : null;
	}, [searchParams]);

	// Deep links auto-expand the selected namespace's ancestry; everything else
	// starts collapsed. Keys are iid-scoped so two integrations sharing names
	// cannot cross-expand. The initializer covers the first mount; the effect
	// re-applies the same walk when in-app deep links or back/forward
	// navigation change `ns` while the page stays mounted. Additive — a user's
	// own collapses elsewhere in the tree are kept.
	const nsParam = searchParams.get('ns');
	const [expanded, setExpanded] = useState<Set<string>>(() =>
		expandedWithAncestry(new Set(), iid, nsParam),
	);
	useEffect(() => {
		setExpanded((prev) => expandedWithAncestry(prev, iid, nsParam));
	}, [iid, nsParam]);

	const isExpanded = (namespace: string[]) => expanded.has(`${iid}:${namespace.join(NS_JOIN)}`);
	const toggleExpanded = (namespace: string[]) => {
		const key = `${iid}:${namespace.join(NS_JOIN)}`;
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const setQuery = (value: string) => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (value) next.set('q', value);
				else next.delete('q');
				return next;
			},
			{ replace: true },
		);
	};

	const selectTable = (namespace: string[], table: string) => {
		setSearchParams((prev) => {
			const next = new URLSearchParams(prev);
			next.set('ns', namespace.join(NS_JOIN));
			next.set('table', table);
			return next;
		});
	};

	const selectIntegration = (entry: IntegrationEntry) => {
		// A different integration means a different tree; selection does not carry.
		const kind = kindsByName.get(entry.kind);
		const surface = supportsTableBrowse(kind)
			? 'tables'
			: supportsObjectBrowse(kind)
				? 'objects'
				: undefined;
		void navigate(
			`/projects/${pid}/data/${entry.id}${surface === undefined ? '' : `?surface=${surface}`}`,
		);
	};

	const refresh = async () => {
		setRefreshing(true);
		try {
			await refreshBrowseQueries(queryClient);
		} finally {
			setRefreshing(false);
		}
	};

	const selected = dataIntegrations.find((entry) => entry.id === iid);
	const selectedKind = selected ? kindsByName.get(selected.kind) : undefined;
	const selectedNotebookInfo = selected
		? integrationNotebookInfo(selected, selectedKind)
		: undefined;
	const requestedSurface = searchParams.get('surface');
	const selectedCapability = useBrowseCapabilityQuery(pid!, iid ?? '', selected !== undefined);
	const querySurface = selectedCapability.data?.surfaces.query;
	const canManageQueries = project.your_role === 'manager' || project.your_role === 'admin';
	const querySurfaceAvailable =
		canManageQueries &&
		(capabilities?.data_browser?.query ?? false) &&
		(querySurface?.available ?? false);
	const showQuerySurface = canManageQueries && querySurface !== undefined;
	const selectedSurface =
		requestedSurface === 'query' && querySurfaceAvailable
			? 'query'
			: requestedSurface === 'objects' && supportsObjectBrowse(selectedKind)
				? 'objects'
				: supportsTableBrowse(selectedKind)
					? 'tables'
					: supportsObjectBrowse(selectedKind)
						? 'objects'
						: undefined;
	const selectedTableCapability = tableBrowseCapability(selectedCapability.data);
	const selectedObjectCapability = objectBrowseCapability(selectedCapability.data);
	const selectSurface = (surface: 'tables' | 'objects' | 'query') => {
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			next.set('surface', surface);
			for (const name of surface === 'objects'
				? ['ns', 'table']
				: ['bucket', 'prefix', 'key', 'version']) {
				next.delete(name);
			}
			next.delete('q');
			return next;
		});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-6 max-md:overflow-y-auto max-md:p-3">
			<title>{`Data · ${project.name} · marimohub`}</title>
			<div className="flex items-center justify-between gap-4">
				<div className="flex min-w-0 items-center gap-2">
					<IconLink
						to={`/projects/${pid}`}
						label="Back to project"
						tooltip="Back to project"
						variant="bordered"
						size="md"
					>
						<ArrowLeft className="size-4" />
					</IconLink>
					<h1 className="truncate text-xl font-semibold tracking-tight">Data</h1>
					<span className="truncate text-sm text-muted-foreground">{project.name}</span>
				</div>
				{available && (
					<Button variant="default" onPress={() => void refresh()} isDisabled={refreshing}>
						<RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
						Refresh
					</Button>
				)}
			</div>
			{selectedKind &&
				[
					supportsTableBrowse(selectedKind),
					supportsObjectBrowse(selectedKind),
					showQuerySurface,
				].filter(Boolean).length > 1 && (
					<div
						className="flex w-fit rounded-md border border-input p-1"
						aria-label="Browse surface"
					>
						{supportsTableBrowse(selectedKind) ? (
							<Button
								size="sm"
								variant={selectedSurface === 'tables' ? 'primary' : 'ghost'}
								onPress={() => selectSurface('tables')}
							>
								Tables
							</Button>
						) : null}
						{supportsObjectBrowse(selectedKind) ? (
							<Button
								size="sm"
								variant={selectedSurface === 'objects' ? 'primary' : 'ghost'}
								onPress={() => selectSurface('objects')}
							>
								Objects
							</Button>
						) : null}
						{showQuerySurface ? (
							<Button
								size="sm"
								variant={selectedSurface === 'query' ? 'primary' : 'ghost'}
								onPress={() => selectSurface('query')}
								isDisabled={!querySurfaceAvailable}
								aria-describedby={querySurfaceAvailable ? undefined : 'query-surface-unavailable'}
							>
								Query
							</Button>
						) : null}
					</div>
				)}
			{showQuerySurface && !querySurfaceAvailable && (
				<div
					role="status"
					id="query-surface-unavailable"
					className="block rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
				>
					<p>
						<span className="font-medium">Run SQL unavailable.</span>{' '}
						<span className="text-muted-foreground">
							{querySurface.reason ?? 'This integration is not SQL-ready.'}
						</span>
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Edit this integration under Project environment → Integrations to see its SQL-ready
						checklist.
					</p>
				</div>
			)}
			{!available ? (
				<EmptyState
					icon={<Database />}
					message="Data browsing is not available"
					description="It may be disabled on this deployment, or your role in this project cannot browse data."
				/>
			) : dataIntegrations.length === 0 ? (
				<EmptyState
					icon={<Database />}
					message="No data integrations"
					description="No enabled integration in this project can be explored here."
				/>
			) : (
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)] gap-4 text-sm max-lg:grid-cols-1 max-lg:overflow-y-auto">
					<div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-xl border bg-card p-3 max-lg:max-h-[50vh]">
						{selectedSurface === 'tables' && (
							<SearchField
								aria-label="Filter tables"
								placeholder="Filter tables..."
								value={query}
								onChange={setQuery}
							/>
						)}
						<div className="min-h-0 flex-1 overflow-y-auto">
							{dataIntegrations.map((entry) => (
								<IntegrationSection
									key={entry.id}
									projectId={pid!}
									entry={entry}
									kind={kindsByName.get(entry.kind)}
									active={entry.id === iid}
									showTree={
										entry.id === iid &&
										(selectedSurface === 'tables' || selectedSurface === 'query')
									}
									query={query}
									selection={entry.id === iid ? selection : null}
									isExpanded={isExpanded}
									toggleExpanded={toggleExpanded}
									onActivate={() => selectIntegration(entry)}
									onSelectTable={selectTable}
								/>
							))}
						</div>
					</div>
					<div
						className={cn(
							'min-h-0',
							selectedSurface === 'tables' && 'overflow-y-auto rounded-xl border bg-card p-4',
						)}
					>
						{selected && selectedSurface === 'query' ? (
							<Suspense fallback={<Skeleton className="h-full min-h-96 w-full" />}>
								<SqlWorkspace
									projectId={pid!}
									integrationId={selected.id}
									integrationName={selected.name}
									selection={selection}
									aiAvailable={capabilities?.data_browser?.ai_query ?? false}
								/>
							</Suspense>
						) : selected && selectedSurface === 'objects' ? (
							selectedObjectCapability?.available ? (
								<ObjectBrowser
									projectId={pid!}
									integration={selected}
									previewAvailable={selectedObjectCapability.preview}
									downloadAvailable={selectedObjectCapability.download}
									searchAvailable={selectedObjectCapability.search === 'bounded-key-name'}
									versionsAvailable={selectedObjectCapability.versions}
									rootKind={selectedObjectCapability.root_kind}
									uriScheme={selectedObjectCapability.uri_scheme}
								/>
							) : (
								<EmptyState
									icon={<Folder />}
									message="Object browsing unavailable"
									description={
										selectedCapability.error
											? errorMessage(selectedCapability.error)
											: (selectedObjectCapability?.reason ?? 'Checking object-store access…')
									}
								/>
							)
						) : selected && selectedKind && selectedNotebookInfo ? (
							<NotebookIntegrationDetail
								projectId={pid!}
								integration={selected}
								kind={selectedKind}
								info={selectedNotebookInfo}
							/>
						) : selected && selection ? (
							<TableDetail
								// Remount per table so per-table state (the column filter)
								// never carries over and blanks the next table's columns.
								key={[selected.id, ...selection.namespace, selection.table].join(NS_JOIN)}
								projectId={pid!}
								integration={selected}
								selection={selection}
								previewAvailable={selectedTableCapability?.preview ?? false}
							/>
						) : selected ? (
							<EmptyState
								icon={<Table2 />}
								message="Select a Table"
								description="Drill into a namespace and choose a table to see its schema, stats, and a ready-to-paste load snippet."
							/>
						) : (
							<EmptyState
								icon={<Database />}
								message="Select an Integration"
								description="Choose an integration to browse its data or connect from a notebook."
							/>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function NotebookIntegrationDetail({
	projectId,
	integration,
	kind,
	info,
}: {
	projectId: string;
	integration: IntegrationEntry;
	kind: IntegrationKind;
	info: NonNullable<ReturnType<typeof integrationNotebookInfo>>;
}) {
	const iconSlug = kind.brand.icon;
	const BrandIcon = iconSlug ? BRAND_ICONS[iconSlug] : undefined;
	const notebook = {
		title: `connect_${integration.name.replaceAll('-', '_')}`,
		heading: `${kind.title}: ${integration.name}`,
		description: `Connect to the ${integration.name} ${kind.title} integration.`,
		snippet: info.snippet,
	};

	return (
		<article className="flex h-full flex-col gap-6 overflow-y-auto rounded-xl border bg-card p-5 sm:p-6">
			<header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 items-center gap-3">
					<div
						className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-background"
						style={{ color: kind.brand.color }}
					>
						{BrandIcon ? (
							<BrandIcon className="size-6" aria-hidden />
						) : (
							<Database className="size-5" aria-hidden />
						)}
					</div>
					<div className="min-w-0">
						<p className="text-sm text-muted-foreground" translate="no">
							{kind.title}
						</p>
						<h2 className="break-words text-xl font-semibold text-balance" translate="no">
							{integration.name}
						</h2>
					</div>
				</div>
				<OpenInNotebookButton
					projectId={projectId}
					notebook={notebook}
					label="Create PySpark Notebook"
					className="w-full sm:w-auto"
				/>
			</header>

			<section className="max-w-3xl rounded-lg border border-primary/20 bg-primary/5 p-4">
				<h3 className="font-medium">Connect from a Notebook</h3>
				<p className="mt-1 text-sm text-pretty text-muted-foreground">{info.description}</p>
			</section>

			{kind.requirements.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="text-sm font-medium">Required Package</h3>
					<div className="flex flex-wrap gap-1.5">
						{kind.requirements.map((requirement) => (
							<Chip key={requirement}>
								<code translate="no">{requirement}</code>
							</Chip>
						))}
					</div>
				</section>
			)}

			<NotebookSnippet snippet={info.snippet} title="PySpark Connection Code" />
		</article>
	);
}

interface TreeHandlers {
	query: string;
	selection: Selection | null;
	isExpanded: (namespace: string[]) => boolean;
	toggleExpanded: (namespace: string[]) => void;
	onSelectTable: (namespace: string[], table: string) => void;
}

function IntegrationSection({
	projectId,
	entry,
	kind,
	active,
	showTree,
	onActivate,
	...handlers
}: {
	projectId: string;
	entry: IntegrationEntry;
	kind: IntegrationKind | undefined;
	active: boolean;
	showTree: boolean;
	onActivate: () => void;
} & TreeHandlers) {
	const capability = useBrowseCapabilityQuery(projectId, entry.id, active);
	const tables = tableBrowseCapability(capability.data);
	const iconSlug = kind?.brand.icon;
	const BrandIcon = iconSlug ? BRAND_ICONS[iconSlug] : undefined;

	return (
		<div>
			<button
				type="button"
				data-testid="browse-integration"
				aria-current={active}
				onClick={onActivate}
				className={cn(
					'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
					active && 'bg-primary/10',
				)}
			>
				{BrandIcon ? (
					<BrandIcon className="size-4 shrink-0" style={{ color: kind?.brand.color }} aria-hidden />
				) : (
					<Database className="size-4 shrink-0" style={{ color: kind?.brand.color }} aria-hidden />
				)}
				<span className="truncate font-medium">{entry.name}</span>
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">
					{kind?.title ?? entry.kind}
				</span>
			</button>
			{active &&
				showTree &&
				(capability.data === undefined ? (
					<LoadState depth={1} error={capability.error ?? undefined} />
				) : tables?.available ? (
					<NamespaceLevel
						projectId={projectId}
						integrationId={entry.id}
						parent={[]}
						depth={1}
						{...handlers}
					/>
				) : (
					<LoadState
						depth={1}
						hint={tables?.reason ?? 'This instance cannot be browsed as a table catalog.'}
					/>
				))}
		</div>
	);
}

function LoadState({ depth, error, hint }: { depth: number; error?: unknown; hint?: string }) {
	return (
		<div
			className="px-2 py-1.5 text-xs text-muted-foreground"
			style={{ paddingLeft: `${depth * 16 + 8}px` }}
		>
			{error ? (
				<span className="text-destructive">
					<span className="block">{errorMessage(error)}</span>
					{error instanceof ApiRequestError && error.requestId ? (
						<span className="mt-0.5 block font-mono text-[0.6875rem] text-muted-foreground">
							Reference: {error.requestId}
						</span>
					) : null}
				</span>
			) : hint ? (
				<span>{hint}</span>
			) : (
				<Skeleton className="h-4 w-32" />
			)}
		</div>
	);
}

function LoadMore({
	depth,
	pending,
	onPress,
}: {
	depth: number;
	pending: boolean;
	onPress: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPress}
			disabled={pending}
			className="w-full rounded-md px-2 py-1 text-left text-xs text-primary hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
			style={{ paddingLeft: `${depth * 16 + 26}px` }}
		>
			{pending ? 'Loading…' : 'Load more'}
		</button>
	);
}

function NamespaceLevel({
	projectId,
	integrationId,
	parent,
	depth,
	...handlers
}: {
	projectId: string;
	integrationId: string;
	parent: string[];
	depth: number;
} & TreeHandlers) {
	const namespaces = useBrowseNamespacesQuery(projectId, integrationId, parent);
	if (namespaces.data === undefined) {
		return <LoadState depth={depth} error={namespaces.error ?? undefined} />;
	}
	// Namespaces are never filtered out: tables load only when their namespace
	// is expanded, so hiding a collapsed namespace would make its matching
	// tables unreachable. The filter applies to table rows.
	const items = namespaces.data.pages.flatMap((page) => page.items);
	return (
		<div>
			{items.map((namespace) => (
				<NamespaceNode
					key={namespace.join(NS_JOIN)}
					projectId={projectId}
					integrationId={integrationId}
					namespace={namespace}
					depth={depth}
					{...handlers}
				/>
			))}
			{/* Roots hold no tables in Iceberg; nested levels list theirs beside child namespaces. */}
			{parent.length > 0 && (
				<TableRows
					projectId={projectId}
					integrationId={integrationId}
					namespace={parent}
					depth={depth}
					{...handlers}
				/>
			)}
			{namespaces.hasNextPage && (
				<LoadMore
					depth={depth}
					pending={namespaces.isFetchingNextPage}
					onPress={() => void namespaces.fetchNextPage()}
				/>
			)}
		</div>
	);
}

function NamespaceNode({
	projectId,
	integrationId,
	namespace,
	depth,
	...handlers
}: {
	projectId: string;
	integrationId: string;
	namespace: string[];
	depth: number;
} & TreeHandlers) {
	const open = handlers.isExpanded(namespace);
	return (
		<div>
			<button
				type="button"
				data-testid="browse-namespace"
				aria-expanded={open}
				onClick={() => handlers.toggleExpanded(namespace)}
				className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				style={{ paddingLeft: `${depth * 16 + 8}px` }}
			>
				{open ? (
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
				) : (
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
				)}
				<Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				<span className="truncate font-medium">{namespace.at(-1)}</span>
			</button>
			{open && (
				<NamespaceLevel
					projectId={projectId}
					integrationId={integrationId}
					parent={namespace}
					depth={depth + 1}
					{...handlers}
				/>
			)}
		</div>
	);
}

function TableRows({
	projectId,
	integrationId,
	namespace,
	depth,
	...handlers
}: {
	projectId: string;
	integrationId: string;
	namespace: string[];
	depth: number;
} & TreeHandlers) {
	const tables = useBrowseTablesQuery(projectId, integrationId, namespace);
	if (tables.data === undefined) {
		return <LoadState depth={depth} error={tables.error ?? undefined} />;
	}
	const { query, selection, onSelectTable } = handlers;
	const loaded = tables.data.pages.flatMap((page) => page.items);
	const items = loaded.filter(
		(table) => query === '' || table.toLowerCase().includes(query.toLowerCase()),
	);
	return (
		<div>
			{loaded.length > 0 && items.length === 0 && (
				<LoadState depth={depth} hint={`No tables here match "${query}".`} />
			)}
			{items.map((table) => {
				const isSelected =
					selection !== null &&
					selection.table === table &&
					selection.namespace.join(NS_JOIN) === namespace.join(NS_JOIN);
				return (
					<button
						key={table}
						type="button"
						data-testid="browse-table"
						aria-current={isSelected}
						onClick={() => onSelectTable(namespace, table)}
						className={cn(
							'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							isSelected && 'bg-primary/10 text-primary',
						)}
						style={{ paddingLeft: `${depth * 16 + 26}px` }}
					>
						<Table2 className="size-4 shrink-0" aria-hidden />
						<span className="truncate">{table}</span>
					</button>
				);
			})}
			{tables.hasNextPage && (
				<LoadMore
					depth={depth}
					pending={tables.isFetchingNextPage}
					onPress={() => void tables.fetchNextPage()}
				/>
			)}
		</div>
	);
}

function TableDetail({
	projectId,
	integration,
	selection,
	previewAvailable,
}: {
	projectId: string;
	integration: IntegrationEntry;
	selection: Selection;
	previewAvailable: boolean;
}) {
	const schema = useBrowseTableSchemaQuery(
		projectId,
		integration.id,
		selection.namespace,
		selection.table,
	);
	const [columnFilter, setColumnFilter] = useState('');
	const qualifiedName = [...selection.namespace, selection.table].join('.');

	if (schema.data === undefined) {
		return schema.error ? (
			<p className="text-destructive">
				{schema.error instanceof Error ? schema.error.message : 'Request failed'}
			</p>
		) : (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-5 w-48" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-full" />
			</div>
		);
	}

	const snapshot = schema.data.current_snapshot;
	const columns = schema.data.columns.filter(
		(column) =>
			columnFilter === '' || column.name.toLowerCase().includes(columnFilter.toLowerCase()),
	);
	const schemaContent = (
		<div className="flex flex-col gap-2">
			<TextField
				aria-label="Filter columns"
				placeholder="Filter columns..."
				value={columnFilter}
				onChange={setColumnFilter}
			/>
			<table className="w-full text-left text-xs">
				<thead>
					<tr className="border-b border-input text-muted-foreground">
						<th className="py-1.5 pr-2 font-medium">Column</th>
						<th className="py-1.5 pr-2 font-medium">Type</th>
						<th className="py-1.5 pr-2 font-medium">Nullable</th>
						<th className="py-1.5 font-medium">Comment</th>
					</tr>
				</thead>
				<tbody>
					{columns.map((column) => (
						<tr key={column.name} className="border-b border-input/50">
							<td className="py-1.5 pr-2 font-mono">{column.name}</td>
							<td className="py-1.5 pr-2 font-mono text-muted-foreground">{column.type}</td>
							<td className="py-1.5 pr-2 text-muted-foreground">
								{column.nullable ? 'yes' : 'no'}
							</td>
							<td className="py-1.5 text-muted-foreground">{column.comment ?? ''}</td>
						</tr>
					))}
				</tbody>
			</table>
			{columns.length === 0 && (
				<p className="text-xs text-muted-foreground">No columns match "{columnFilter}".</p>
			)}
		</div>
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
					<span className="text-sm text-muted-foreground">{integration.name}</span>
					{selection.namespace.map((part, index) => (
						<span
							key={selection.namespace.slice(0, index + 1).join(NS_JOIN)}
							className="flex items-baseline gap-1.5 text-sm text-muted-foreground"
						>
							<span aria-hidden>/</span>
							{part}
						</span>
					))}
					<span className="flex items-baseline gap-1.5 text-base font-semibold">
						<span aria-hidden className="text-sm font-normal text-muted-foreground">
							/
						</span>
						{selection.table}
					</span>
				</div>
				{schema.data.snippet && (
					<OpenInNotebookButton
						projectId={projectId}
						notebook={{
							title: `explore_${selection.table}`,
							heading: qualifiedName,
							description: `Explore ${qualifiedName} via the ${integration.name} integration`,
							snippet: schema.data.snippet,
						}}
					/>
				)}
			</div>

			{(snapshot || schema.data.format_version !== undefined) && (
				<div className="flex flex-wrap items-center gap-1.5">
					{snapshot?.total_records !== undefined && (
						<Chip>{countFormatter.format(snapshot.total_records)} rows</Chip>
					)}
					{snapshot?.total_data_size_bytes !== undefined && (
						<Chip>{formatBytes(snapshot.total_data_size_bytes)}</Chip>
					)}
					{snapshot?.committed_at && (
						<Chip>
							<time dateTime={snapshot.committed_at} title={snapshot.committed_at}>
								updated {formatRelative(snapshot.committed_at)}
							</time>
						</Chip>
					)}
					{schema.data.format_version !== undefined && (
						<Chip>format v{schema.data.format_version}</Chip>
					)}
				</div>
			)}

			{schema.data.location && (
				<p
					className="truncate font-mono text-xs text-muted-foreground"
					title={schema.data.location}
				>
					{schema.data.location}
				</p>
			)}

			{previewAvailable ? (
				<TableDetailTabs
					projectId={projectId}
					integrationId={integration.id}
					selection={selection}
					schemaContent={schemaContent}
				/>
			) : (
				schemaContent
			)}

			{schema.data.partitioning && schema.data.partitioning.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">Partitioned by</span>
					{schema.data.partitioning.map((field) => (
						<Chip key={field}>{field}</Chip>
					))}
				</div>
			)}

			{schema.data.snippet && (
				<NotebookSnippet snippet={schema.data.snippet} title="Load in a Notebook" />
			)}
		</div>
	);
}

function TableDetailTabs({
	projectId,
	integrationId,
	selection,
	schemaContent,
}: {
	projectId: string;
	integrationId: string;
	selection: Selection;
	schemaContent: ReactNode;
}) {
	const [tab, setTab] = useState<'schema' | 'preview'>('schema');
	const preview = useBrowseTablePreview(projectId, integrationId);
	return (
		<Tabs
			selectedKey={tab}
			onSelectionChange={(key) => setTab(key as 'schema' | 'preview')}
			className="flex flex-col gap-4"
		>
			<TabList aria-label="Table details" className="flex border-b border-input">
				{(['schema', 'preview'] as const).map((value) => (
					<Tab
						key={value}
						id={value}
						className={({ isSelected, isFocusVisible }) =>
							cn(
								'-mb-px cursor-default border-b-2 px-3 py-2 text-xs font-medium capitalize outline-none',
								isSelected
									? 'border-primary text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
								isFocusVisible && 'ring-2 ring-ring ring-offset-2',
							)
						}
					>
						{value === 'schema' ? 'Schema' : 'Preview'}
					</Tab>
				))}
			</TabList>
			<TabPanel id="schema" className="outline-none">
				{schemaContent}
			</TabPanel>
			<TabPanel id="preview" className="flex flex-col gap-3 outline-none">
				<div>
					<Button
						variant="primary"
						onPress={() =>
							preview.mutate({
								namespace: selection.namespace,
								table: selection.table,
								limit: 20,
							})
						}
						isDisabled={preview.isPending}
					>
						{preview.isPending ? 'Loading…' : preview.data ? 'Reload preview' : 'Load preview'}
					</Button>
				</div>
				{preview.error && (
					<p className="text-sm text-destructive">
						{preview.error instanceof Error ? preview.error.message : 'Request failed'}
					</p>
				)}
				{preview.data && (
					<TabularPreviewGrid
						columns={preview.data.columns}
						rows={preview.data.rows}
						emptyMessage="This table returned no rows."
					/>
				)}
			</TabPanel>
		</Tabs>
	);
}
