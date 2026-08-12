import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
	ArrowLeft,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Database,
	Folder,
	NotebookPen,
	RefreshCw,
	Table2,
} from 'lucide-react';
import {
	Button,
	Chip,
	EmptyState,
	IconButton,
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
	useCreateNotebook,
	useIntegrationKindsQuery,
	useIntegrationsQuery,
	useProjectQuery,
} from '@/api/hooks';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { BRAND_ICONS } from '@/components/Project/brandIcons';
import { formatRelative } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { IntegrationEntry, IntegrationKind } from '@/types';

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

/** A marimo notebook seeded with the table's load snippet as its data cell. */
function seededNotebookCode(heading: string, snippet: string): string {
	const cellBody = snippet
		.split('\n')
		.map((line) => (line === '' ? '' : `    ${line}`))
		.join('\n');
	return [
		'import marimo',
		'',
		'app = marimo.App(width="medium", sql_output="native")',
		'',
		'',
		'@app.cell',
		'def _():',
		'    import marimo as mo',
		'    return (mo,)',
		'',
		'',
		'@app.cell(hide_code=True)',
		'def _(mo):',
		`    mo.md(${JSON.stringify(`# ${heading}`)})`,
		'    return',
		'',
		'',
		'@app.cell',
		'def _():',
		cellBody,
		'    return',
		'',
		'',
		'if __name__ == "__main__":',
		'    app.run()',
		'',
	].join('\n');
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
	const browsable = useMemo(
		() =>
			(entries ?? []).filter(
				(entry) => entry.enabled && !entry.shadowed && kindsByName.get(entry.kind)?.supports_browse,
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

	const selectIntegration = (id: string) => {
		// A different integration means a different tree; selection does not carry.
		void navigate(`/projects/${pid}/data/${id}${query ? `?q=${encodeURIComponent(query)}` : ''}`);
	};

	const refresh = async () => {
		setRefreshing(true);
		try {
			await refreshBrowseQueries(queryClient);
		} finally {
			setRefreshing(false);
		}
	};

	const selected = browsable.find((entry) => entry.id === iid);
	const selectedCapability = useBrowseCapabilityQuery(pid!, iid ?? '', selected !== undefined);

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

			{!available ? (
				<EmptyState
					icon={<Database />}
					message="Data browsing is not available"
					description="It may be disabled on this deployment, or your role in this project cannot browse data."
				/>
			) : browsable.length === 0 ? (
				<EmptyState
					icon={<Database />}
					message="Nothing to browse"
					description="No enabled integration in this project supports browsing."
				/>
			) : (
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)] gap-4 text-sm max-lg:grid-cols-1 max-lg:overflow-y-auto">
					<div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-xl border bg-card p-3 max-lg:max-h-[50vh]">
						<SearchField
							aria-label="Filter tables"
							placeholder="Filter tables..."
							value={query}
							onChange={setQuery}
						/>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{browsable.map((entry) => (
								<IntegrationSection
									key={entry.id}
									projectId={pid!}
									entry={entry}
									kind={kindsByName.get(entry.kind)}
									active={entry.id === iid}
									query={query}
									selection={entry.id === iid ? selection : null}
									isExpanded={isExpanded}
									toggleExpanded={toggleExpanded}
									onActivate={() => selectIntegration(entry.id)}
									onSelectTable={selectTable}
								/>
							))}
						</div>
					</div>
					<div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-4">
						{selected && selection ? (
							<TableDetail
								// Remount per table so per-table state (the column filter)
								// never carries over and blanks the next table's columns.
								key={[selected.id, ...selection.namespace, selection.table].join(NS_JOIN)}
								projectId={pid!}
								integration={selected}
								selection={selection}
								previewAvailable={selectedCapability.data?.preview ?? false}
							/>
						) : (
							<EmptyState
								icon={<Table2 />}
								message="Select a table"
								description="Pick an integration on the left, then drill into a namespace and choose a table to see its schema, stats, and a ready-to-paste load snippet."
							/>
						)}
					</div>
				</div>
			)}
		</div>
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
	onActivate,
	...handlers
}: {
	projectId: string;
	entry: IntegrationEntry;
	kind: IntegrationKind | undefined;
	active: boolean;
	onActivate: () => void;
} & TreeHandlers) {
	const capability = useBrowseCapabilityQuery(projectId, entry.id, active);
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
				(capability.data === undefined ? (
					<LoadState depth={1} error={capability.error ?? undefined} />
				) : capability.data.metadata ? (
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
						hint={capability.data.reason ?? 'This instance cannot be browsed.'}
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
					{error instanceof Error ? error.message : 'Request failed'}
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
	const { copied, copy } = useCopyToClipboard();
	const [columnFilter, setColumnFilter] = useState('');
	const [tab, setTab] = useState<'schema' | 'preview'>('schema');
	const preview = useBrowseTablePreview(projectId, integration.id);
	const createNotebook = useCreateNotebook(projectId);
	const navigate = useNavigate();
	const qualifiedName = [...selection.namespace, selection.table].join('.');

	const openInNotebook = async () => {
		const snippet = schema.data?.snippet;
		if (!snippet) return;
		const title = `explore_${selection.table}`;
		try {
			const created = await createNotebook.mutateAsync({
				title,
				description: `Explore ${qualifiedName} via the ${integration.name} integration`,
				code: seededNotebookCode(qualifiedName, snippet),
			});
			toast.success(`Created "${title}"`);
			void navigate(`/projects/${projectId}/notebooks/${created.id}`, { state: { title } });
		} catch {
			// Keep the page state; the global mutation handler reports the error.
		}
	};

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
					<Button
						variant="primary"
						onPress={() => void openInNotebook()}
						isDisabled={createNotebook.isPending}
					>
						<NotebookPen className="size-4" />
						{createNotebook.isPending ? 'Creating…' : 'Open in notebook'}
					</Button>
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

			{previewAvailable && (
				<div role="tablist" aria-label="Table details" className="flex border-b border-input">
					{(['schema', 'preview'] as const).map((value) => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={tab === value}
							onClick={() => setTab(value)}
							className={cn(
								'-mb-px border-b-2 px-3 py-2 text-xs font-medium capitalize',
								tab === value
									? 'border-primary text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
							)}
						>
							{value === 'schema' ? 'Schema' : 'Preview'}
						</button>
					))}
				</div>
			)}

			{tab === 'schema' ? (
				<div role="tabpanel" aria-label="Schema" className="flex flex-col gap-2">
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
			) : (
				<div role="tabpanel" aria-label="Preview" className="flex flex-col gap-3">
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
					{preview.data && <PreviewTable data={preview.data} />}
				</div>
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
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between">
						<span className="text-xs font-medium text-muted-foreground">Load in a notebook</span>
						<IconButton
							label={copied ? 'Copied' : 'Copy snippet'}
							tooltip={copied ? 'Copied' : 'Copy snippet'}
							onPress={() => void copy(schema.data.snippet ?? '')}
						>
							{copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
						</IconButton>
					</div>
					<pre className="overflow-x-auto rounded-md border border-input bg-muted/40 p-3 font-mono text-xs">
						{schema.data.snippet}
					</pre>
				</div>
			)}
		</div>
	);
}

function PreviewTable({ data }: { data: { columns: string[]; rows: unknown[][] } }) {
	if (data.rows.length === 0) {
		return <p className="text-xs text-muted-foreground">This table returned no rows.</p>;
	}
	return (
		<div className="overflow-x-auto rounded-md border border-input">
			<table className="w-full whitespace-nowrap text-left text-xs">
				<thead className="bg-muted/40">
					<tr>
						{data.columns.map((column) => (
							<th key={column} className="px-3 py-2 font-medium">
								{column}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{keyedRows(data.rows).map(({ key, row }) => (
						<tr key={key} className="border-t border-input/50">
							{data.columns.map((column, columnIndex) => (
								<td
									key={column}
									className="max-w-80 truncate px-3 py-2 font-mono"
									title={renderCell(row[columnIndex])}
								>
									{renderCell(row[columnIndex])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function keyedRows(rows: unknown[][]): { key: string; row: unknown[] }[] {
	const counts = new Map<string, number>();
	return rows.map((row) => {
		const base = JSON.stringify(row) ?? '[unserializable]';
		const occurrence = counts.get(base) ?? 0;
		counts.set(base, occurrence + 1);
		return { key: `${base}:${occurrence}`, row };
	});
}

function renderCell(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '[unserializable]';
	}
}
