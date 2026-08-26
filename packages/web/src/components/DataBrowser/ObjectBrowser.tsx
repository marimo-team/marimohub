import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button as AriaButton, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { toast } from 'sonner';
import {
	ArrowUp,
	Check,
	ChevronRight,
	Copy,
	Download,
	File,
	Folder,
	HardDrive,
	Link2,
	Search,
	X,
} from 'lucide-react';
import { withBasePath } from '@/lib/basePath';
import {
	objectContentUrl,
	useObjectBucketsQuery,
	useObjectDetailQuery,
	useObjectPreview,
	useObjectSearchQuery,
	useObjectsQuery,
	useObjectVersionsQuery,
} from '@/api/hooks';
import {
	Button,
	Chip,
	EmptyState,
	IconButton,
	Skeleton,
	TextField,
	Tooltip,
} from '@/components/ui';
import { iconControlClass } from '@/components/ui/iconControl';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { errorMessage } from '@/lib/errors';
import { cn, logNever } from '@/lib/utils';
import type {
	IntegrationBrowseCapability,
	IntegrationEntry,
	IntegrationObjectEntry,
	IntegrationObjectPreview,
} from '@/types';
import { OpenInNotebookButton } from './NotebookActions';
import { TabularPreviewGrid } from './TabularPreviewGrid';

type ObjectCapability = NonNullable<IntegrationBrowseCapability['surfaces']['objects']>;
type ObjectRootKind = ObjectCapability['root_kind'];
type ObjectUriScheme = ObjectCapability['uri_scheme'];

interface ObjectBrowserProps {
	projectId: string;
	integration: IntegrationEntry;
	previewAvailable: boolean;
	downloadAvailable: boolean;
	searchAvailable: boolean;
	versionsAvailable: boolean;
	rootKind: ObjectRootKind;
	uriScheme: ObjectUriScheme;
}

const rowGridClass =
	'grid grid-cols-[1.75rem_minmax(0,1fr)_5rem_9.5rem] items-center gap-3 max-md:grid-cols-[1.75rem_minmax(0,1fr)_5rem]';

// Every crumb — button or text — shares one h-7 box (mobile min-h-11
// overridden), so navigating never changes the toolbar height.
const crumbTextClass = 'flex h-7 min-w-0 items-center px-1.5';
const crumbButtonClass = 'h-7 px-1.5 max-md:min-h-7';

export function ObjectBrowser({
	projectId,
	integration,
	previewAvailable,
	downloadAvailable,
	searchAvailable,
	versionsAvailable,
	rootKind,
	uriScheme,
}: ObjectBrowserProps) {
	const rootLabel = objectRootLabel(rootKind);
	const [params, setParams] = useSearchParams();
	const bucketParam = params.get('bucket') ?? '';
	const prefix = params.get('prefix') ?? '';
	const key = params.get('key') ?? '';
	const versionId = params.get('version') ?? undefined;
	const searchQuery = params.get('q') ?? '';
	const activeSearchQuery = searchAvailable ? searchQuery : '';
	const [filter, setFilter] = useState('');
	const [formatFilter, setFormatFilter] = useState('all');
	const [sizeFilter, setSizeFilter] = useState('all');
	const [modifiedAfter, setModifiedAfter] = useState('');
	const [sort, setSort] = useState('name-asc');
	const [selection, setSelection] = useState(() => ({
		location: objectSelectionLocation(bucketParam, prefix, key),
		keys: new Set(key ? [key] : []),
	}));
	const [searchDraft, setSearchDraft] = useState(searchQuery);
	useEffect(() => setSearchDraft(searchQuery), [searchQuery]);
	const buckets = useObjectBucketsQuery(projectId, integration.id);
	const bucketItems = buckets.data?.pages.flatMap((page) => page.items) ?? [];
	const bucket =
		bucketParam || (bucketItems.length === 1 && !buckets.hasNextPage ? bucketItems[0].name : '');
	const selectionLocation = objectSelectionLocation(bucket, prefix, key);
	const selectedKeys =
		selection.location === selectionLocation ? selection.keys : new Set(key ? [key] : []);
	useEffect(() => {
		setSelection((current) =>
			current.location === selectionLocation
				? current
				: { location: selectionLocation, keys: new Set(key ? [key] : []) },
		);
	}, [key, selectionLocation]);
	const listing = useObjectsQuery(
		projectId,
		integration.id,
		bucket,
		prefix,
		activeSearchQuery === '',
	);
	const search = useObjectSearchQuery(projectId, integration.id, bucket, prefix, activeSearchQuery);
	const loaded = useMemo(
		() =>
			activeSearchQuery
				? (search.data?.pages.flatMap((page) => page.items) ?? [])
				: (listing.data?.pages.flatMap((page) => page.items) ?? []),
		[activeSearchQuery, listing.data, search.data],
	);
	const entries = useMemo(() => {
		const normalized = filter.trim().toLocaleLowerCase();
		const after = modifiedAfter ? Date.parse(`${modifiedAfter}T00:00:00Z`) : undefined;
		const filtered = loaded.filter((entry) => {
			if (normalized && !entry.name.toLocaleLowerCase().includes(normalized)) return false;
			if (entry.kind === 'prefix') return true;
			if (formatFilter !== 'all' && objectFormat(entry.name) !== formatFilter) return false;
			if (sizeFilter === 'small' && (entry.size ?? 0) >= 1024 * 1024) return false;
			if (
				sizeFilter === 'medium' &&
				((entry.size ?? 0) < 1024 * 1024 || (entry.size ?? 0) >= 100 * 1024 * 1024)
			)
				return false;
			if (sizeFilter === 'large' && (entry.size ?? 0) < 100 * 1024 * 1024) return false;
			if (after !== undefined && (!entry.last_modified || Date.parse(entry.last_modified) < after))
				return false;
			return true;
		});
		return filtered.toSorted((left, right) => {
			if (left.kind !== right.kind) return left.kind === 'prefix' ? -1 : 1;
			if (sort === 'name-desc') return right.name.localeCompare(left.name);
			if (sort === 'size-desc') return (right.size ?? -1) - (left.size ?? -1);
			if (sort === 'modified-desc')
				return (right.last_modified ?? '').localeCompare(left.last_modified ?? '');
			return left.name.localeCompare(right.name);
		});
	}, [filter, formatFilter, loaded, modifiedAfter, sizeFilter, sort]);

	const update = (changes: Record<string, string | undefined>) => {
		setParams((current) => {
			const next = new URLSearchParams(current);
			next.set('surface', 'objects');
			for (const [name, value] of Object.entries(changes)) {
				if (value) next.set(name, value);
				else next.delete(name);
			}
			return next;
		});
	};
	const selectBucket = (value: string) => {
		const location = objectSelectionLocation(value, '', '');
		setSelection({ location, keys: new Set() });
		update({ bucket: value, prefix: undefined, key: undefined, version: undefined, q: undefined });
	};
	const selectPrefix = (value: string) => {
		const location = objectSelectionLocation(bucket, value, '');
		setSelection({ location, keys: new Set() });
		setSearchDraft('');
		update({ prefix: value, key: undefined, version: undefined, q: undefined });
	};
	const selectEntry = (entry: IntegrationObjectEntry, event?: MouseEvent<HTMLButtonElement>) => {
		if (entry.kind === 'prefix') {
			selectPrefix(entry.key);
		} else {
			const location = objectSelectionLocation(bucket, prefix, entry.key);
			setSelection((current) => {
				if (!(event?.metaKey || event?.ctrlKey)) {
					return { location, keys: new Set([entry.key]) };
				}
				const next = new Set(
					current.location === selectionLocation ? current.keys : key ? [key] : [],
				);
				if (next.has(entry.key)) next.delete(entry.key);
				else next.add(entry.key);
				return { location, keys: next };
			});
			update({ key: entry.key, version: undefined });
		}
	};
	const parentPrefix = prefix ? prefix.replace(/[^/]+\/$/, '') : '';
	const searchSummary = search.data?.pages.at(-1);
	const listError = activeSearchQuery ? search.error : listing.error;
	const results = activeSearchQuery ? search : listing;
	const initialListError = listError && results.data === undefined;
	const { copy: copySelection } = useCopyToClipboard();
	const copySelectedUris = () => {
		const keys = selectedKeys.size > 0 ? [...selectedKeys] : key ? [key] : [];
		const uris = keys.map((value) => objectUri(uriScheme, bucket, value));
		if (!uris.every((uri): uri is string => uri !== null)) {
			toast.error('This provider does not expose a recognized object URI scheme.');
			return;
		}
		void copySelection(uris.join('\n')).then((copied) => {
			if (copied) toast.success(`Copied ${keys.length} object URI${keys.length === 1 ? '' : 's'}`);
		});
	};
	const handleListKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === 'Backspace' && prefix) {
			event.preventDefault();
			selectPrefix(parentPrefix);
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const rows = [
			...(event.currentTarget
				.closest('fieldset')
				?.querySelectorAll<HTMLButtonElement>('[data-object-row]') ?? []),
		];
		if (rows.length === 0) return;
		event.preventDefault();
		const current = rows.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
		rows[next].focus();
	};

	const crumbs = prefixParts(prefix);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
				<div className="flex flex-col gap-2 border-b p-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<nav
							aria-label="Object location"
							className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm"
						>
							{bucket === '' ? (
								<span className={cn(crumbTextClass, 'gap-1.5 font-medium')}>
									<HardDrive className="size-4 text-muted-foreground" aria-hidden />
									{rootLabel.plural}
								</span>
							) : (
								<>
									{/* A lone bucket reselects itself, so the crumb is inert then. */}
									{bucketItems.length > 1 || buckets.hasNextPage ? (
										<Button
											size="sm"
											variant="ghost"
											className={crumbButtonClass}
											onPress={() => selectBucket('')}
										>
											<HardDrive className="size-3.5" aria-hidden />
											{rootLabel.plural}
										</Button>
									) : (
										<span className={cn(crumbTextClass, 'gap-1.5 text-muted-foreground')}>
											<HardDrive className="size-3.5" aria-hidden />
											{rootLabel.plural}
										</span>
									)}
									<ChevronRight
										className="size-3.5 shrink-0 text-muted-foreground/60"
										aria-hidden
									/>
									{crumbs.length === 0 ? (
										<span className={cn(crumbTextClass, 'max-w-56 font-medium')}>
											<span className="truncate" translate="no">
												{bucket}
											</span>
										</span>
									) : (
										<Button
											size="sm"
											variant="ghost"
											className={cn(crumbButtonClass, 'max-w-56')}
											onPress={() => selectPrefix('')}
										>
											<span className="truncate" translate="no">
												{bucket}
											</span>
										</Button>
									)}
									{crumbs.map(({ label, value }, index) => (
										<span key={value} className="flex min-w-0 items-center gap-0.5">
											<ChevronRight
												className="size-3.5 shrink-0 text-muted-foreground/60"
												aria-hidden
											/>
											{index === crumbs.length - 1 ? (
												<span className={cn(crumbTextClass, 'max-w-56 font-medium')}>
													<span className="truncate" translate="no">
														{label}
													</span>
												</span>
											) : (
												<Button
													size="sm"
													variant="ghost"
													className={cn(crumbButtonClass, 'max-w-56')}
													onPress={() => selectPrefix(value)}
												>
													<span className="truncate" translate="no">
														{label}
													</span>
												</Button>
											)}
										</span>
									))}
								</>
							)}
						</nav>
						{selectedKeys.size > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-xs text-muted-foreground">{selectedKeys.size} selected</span>
								<Button size="sm" onPress={copySelectedUris}>
									<Copy className="size-3.5" aria-hidden />
									Copy {selectedKeys.size} selected URI{selectedKeys.size === 1 ? '' : 's'}
								</Button>
							</div>
						)}
					</div>
					{bucket !== '' && (searchAvailable || !initialListError) && (
						<div className="flex flex-wrap items-center gap-2">
							{searchAvailable && (
								<form
									className="flex min-w-52 flex-1 items-start gap-1.5"
									onSubmit={(event) => {
										event.preventDefault();
										const query = searchDraft.trim();
										if (query.length === 0 || query.length >= 2) update({ q: query || undefined });
									}}
								>
									<TextField
										name="object-search"
										autoComplete="off"
										spellCheck="false"
										aria-label="Search object keys"
										placeholder="Search this prefix…"
										value={searchDraft}
										onChange={setSearchDraft}
										className="min-w-0 flex-1"
										error={
											searchDraft.trim().length === 1 ? 'Enter at least two characters.' : undefined
										}
									/>
									<Button type="submit" aria-label="Search object keys">
										<Search className="size-4" aria-hidden />
									</Button>
									{searchQuery && (
										<Button
											onPress={() => {
												setSearchDraft('');
												update({ q: undefined });
											}}
										>
											Clear search
										</Button>
									)}
								</form>
							)}
							{!initialListError && (
								<>
									<TextField
										name="loaded-object-filter"
										autoComplete="off"
										spellCheck="false"
										aria-label="Filter loaded objects"
										placeholder="Filter loaded…"
										value={filter}
										onChange={setFilter}
										className="w-44"
									/>
									<fieldset className="flex flex-wrap items-center gap-2">
										<legend className="sr-only">Object filters</legend>
										<ObjectFilterSelect
											label="Type"
											name="object-format-filter"
											value={formatFilter}
											onChange={setFormatFilter}
										>
											<option value="all">All types</option>
											<option value="data">Data</option>
											<option value="text">Text</option>
											<option value="image">Images</option>
											<option value="other">Other</option>
										</ObjectFilterSelect>
										<ObjectFilterSelect
											label="Size"
											name="object-size-filter"
											value={sizeFilter}
											onChange={setSizeFilter}
										>
											<option value="all">Any size</option>
											<option value="small">Under 1 MiB</option>
											<option value="medium">1–100 MiB</option>
											<option value="large">100 MiB+</option>
										</ObjectFilterSelect>
										<input
											type="date"
											aria-label="Modified after"
											name="object-modified-after"
											autoComplete="off"
											value={modifiedAfter}
											onChange={(event) => setModifiedAfter(event.target.value)}
											className="h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										/>
										<ObjectFilterSelect
											label="Sort loaded results"
											name="object-sort"
											value={sort}
											onChange={setSort}
										>
											<option value="name-asc">Name A–Z</option>
											<option value="name-desc">Name Z–A</option>
											<option value="size-desc">Largest first</option>
											<option value="modified-desc">Newest first</option>
										</ObjectFilterSelect>
									</fieldset>
								</>
							)}
						</div>
					)}
					{activeSearchQuery && searchSummary && (
						<output className="text-xs text-muted-foreground">
							{loaded.length} matches after scanning{' '}
							{search.data?.pages.reduce((n, p) => n + p.scanned, 0)} keys
							{searchSummary.complete ? '.' : '; more may exist.'}
						</output>
					)}
				</div>
				<fieldset className="min-h-0 flex-1 overflow-y-auto p-1.5 pt-0">
					<legend className="sr-only">Objects</legend>
					{bucket === '' ? (
						<div className="pt-1.5">
							{buckets.data === undefined ? (
								buckets.error ? (
									<p className="p-3 text-sm text-destructive">{errorMessage(buckets.error)}</p>
								) : (
									<Skeleton className="h-9 w-full" />
								)
							) : !buckets.error && bucketItems.length === 0 && !buckets.hasNextPage ? (
								<EmptyState
									icon={<Folder />}
									message={`No ${rootLabel.plural.toLocaleLowerCase()} available`}
									description={`The integration credentials did not return an accessible ${rootLabel.singular}.`}
								/>
							) : (
								<>
									{bucketItems.map((item) => (
										<button
											key={item.name}
											type="button"
											onClick={() => selectBucket(item.name)}
											className="flex w-full touch-manipulation items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11"
										>
											<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
												<Folder className="size-4 text-primary/70" aria-hidden />
											</span>
											<span className="truncate font-medium" translate="no">
												{item.name}
											</span>
											{item.configured && <Chip className="ml-auto">configured</Chip>}
										</button>
									))}
									{buckets.error && (
										<p className="p-3 text-sm text-destructive">{errorMessage(buckets.error)}</p>
									)}
									{buckets.hasNextPage && (
										<Button
											className="mt-2 w-full"
											isDisabled={buckets.isFetchingNextPage}
											onPress={() => void buckets.fetchNextPage()}
										>
											{buckets.isFetchingNextPage
												? `Loading ${rootLabel.plural.toLocaleLowerCase()}…`
												: buckets.error
													? `Retry loading ${rootLabel.plural.toLocaleLowerCase()}`
													: `Load more ${rootLabel.plural.toLocaleLowerCase()}`}
										</Button>
									)}
								</>
							)}
						</div>
					) : (
						<>
							{!initialListError && (
								<div
									aria-hidden
									className={cn(
										rowGridClass,
										'sticky top-0 z-10 border-b bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground',
									)}
								>
									<span />
									<span>Name</span>
									<span className="text-right">Size</span>
									<span className="text-right max-md:hidden">Modified</span>
								</div>
							)}
							{initialListError && (
								<div className="mt-1.5 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-4 text-center">
									<p className="text-sm text-destructive">{errorMessage(listError)}</p>
									<Button onPress={() => void results.refetch()}>
										{activeSearchQuery ? 'Retry search' : 'Retry loading objects'}
									</Button>
								</div>
							)}
							{listError && !initialListError && (
								<p className="p-3 text-sm text-destructive">{errorMessage(listError)}</p>
							)}
							{prefix && !activeSearchQuery && (
								<button
									type="button"
									aria-label="Parent prefix"
									onKeyDown={handleListKeyDown}
									onClick={() => selectPrefix(parentPrefix)}
									className="flex w-full touch-manipulation items-center gap-3 rounded-md px-3 py-2 text-left text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11"
								>
									<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
										<ArrowUp className="size-4" aria-hidden />
									</span>
									<span aria-hidden>..</span>
								</button>
							)}
							{!initialListError &&
								entries.map((entry) => {
									const entrySelected = entry.kind === 'object' && selectedKeys.has(entry.key);
									const entryUri =
										entry.kind === 'object' ? objectUri(uriScheme, bucket, entry.key) : null;
									return (
										<div key={`${entry.kind}:${entry.key}`} className="group relative">
											<button
												data-object-row
												type="button"
												aria-pressed={entrySelected}
												onKeyDown={handleListKeyDown}
												onClick={(event) => selectEntry(entry, event)}
												className={cn(
													rowGridClass,
													'w-full touch-manipulation rounded-md px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11',
													entrySelected && 'bg-primary/10',
												)}
											>
												<span className="flex size-7 items-center justify-center rounded-md bg-muted/60">
													{entry.kind === 'prefix' ? (
														<Folder className="size-4 text-primary/70" aria-hidden />
													) : (
														<File className="size-4 text-muted-foreground" aria-hidden />
													)}
												</span>
												<span className="min-w-0">
													<span
														className={cn('block truncate', entrySelected && 'text-primary')}
														translate="no"
													>
														{entry.name}
													</span>
													{entry.kind === 'object' && (
														<span className="block truncate text-[11px] text-muted-foreground">
															{[objectFormatLabel(entry.name), entry.storage_class]
																.filter(Boolean)
																.join(' · ')}
														</span>
													)}
												</span>
												<span className="text-right text-xs text-muted-foreground tabular-nums">
													{entry.size === undefined ? '' : formatBytes(entry.size)}
												</span>
												<span className="text-right text-xs text-muted-foreground tabular-nums max-md:hidden">
													{formatDateTime(entry.last_modified) ?? ''}
												</span>
											</button>
											{entry.kind === 'object' && (
												<div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border bg-card p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
													{entryUri && (
														<RowCopyAction
															label="Copy URI"
															name={entry.name}
															value={entryUri}
															icon={<Link2 className="size-3.5" aria-hidden />}
														/>
													)}
													<RowCopyAction
														label="Copy key"
														name={entry.name}
														value={entry.key}
														icon={<Copy className="size-3.5" aria-hidden />}
													/>
													{downloadAvailable && (
														<Tooltip content="Download">
															<a
																href={objectContentUrl({
																	projectId,
																	integrationId: integration.id,
																	bucket,
																	key: entry.key,
																	etag: entry.etag,
																})}
																aria-label={`Download ${entry.name}`}
																className={iconControlClass({})}
															>
																<Download className="size-3.5" aria-hidden />
															</a>
														</Tooltip>
													)}
												</div>
											)}
										</div>
									);
								})}
							{!initialListError && entries.length === 0 && (listing.data || search.data) && (
								<p className="p-4 text-center text-xs text-muted-foreground">No objects found.</p>
							)}
							{!initialListError &&
								(activeSearchQuery ? search.hasNextPage : listing.hasNextPage) && (
									<Button
										className="mt-2 w-full"
										onPress={() =>
											void (activeSearchQuery ? search.fetchNextPage() : listing.fetchNextPage())
										}
									>
										{activeSearchQuery ? 'Continue search' : 'Load more'}
									</Button>
								)}
						</>
					)}
				</fieldset>
			</section>
			{bucket && key && (
				<ObjectDetailSheet
					title={key.split('/').at(-1) || key}
					onClose={() => update({ key: undefined, version: undefined })}
				>
					<ObjectDetail
						key={JSON.stringify([bucket, key, versionId ?? null])}
						projectId={projectId}
						integration={integration}
						bucket={bucket}
						objectKey={key}
						versionId={versionId}
						previewAvailable={previewAvailable}
						downloadAvailable={downloadAvailable}
						versionsAvailable={versionsAvailable}
						uriScheme={uriScheme}
						onVersion={(value) => update({ version: value })}
					/>
				</ObjectDetailSheet>
			)}
		</div>
	);
}

/** Non-modal on purpose: the list stays clickable, so clicking another row swaps the detail. */
function ObjectDetailSheet({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	useEffect(() => {
		const handle = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', handle);
		return () => window.removeEventListener('keydown', handle);
	}, [onClose]);
	return (
		<aside
			aria-label="Object details"
			className="fixed inset-y-3 right-3 z-40 flex w-[min(30rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in duration-200 fade-in-0 slide-in-from-right-6"
		>
			<div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
				<h2 className="min-w-0 truncate text-sm font-semibold" translate="no">
					{title}
				</h2>
				<IconButton label="Close details" tooltip="Close" onPress={onClose}>
					<X className="size-4" aria-hidden />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
		</aside>
	);
}

function ObjectDetail({
	projectId,
	integration,
	bucket,
	objectKey,
	versionId,
	previewAvailable,
	downloadAvailable,
	versionsAvailable,
	uriScheme,
	onVersion,
}: {
	projectId: string;
	integration: IntegrationEntry;
	bucket: string;
	objectKey: string;
	versionId?: string;
	previewAvailable: boolean;
	downloadAvailable: boolean;
	versionsAvailable: boolean;
	uriScheme: ObjectUriScheme;
	onVersion: (version?: string) => void;
}) {
	const detail = useObjectDetailQuery(projectId, integration.id, bucket, objectKey, versionId);
	const versions = useObjectVersionsQuery(
		projectId,
		integration.id,
		bucket,
		objectKey,
		versionsAvailable,
	);
	const preview = useObjectPreview(projectId, integration.id);
	if (!detail.data) {
		return detail.error ? (
			<p className="text-destructive">
				{detail.error instanceof Error ? detail.error.message : 'Request failed'}
			</p>
		) : (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-5 w-48" />
				<Skeleton className="h-4 w-full" />
			</div>
		);
	}
	const uri = objectUri(uriScheme, bucket, objectKey);
	const displayLocation = uri ?? `${bucket}/${objectKey}`;
	const downloadUrl = objectContentUrl({
		projectId,
		integrationId: integration.id,
		bucket,
		key: objectKey,
		versionId,
		etag: detail.data.etag,
	});
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2.5">
				<p className="break-all font-mono text-xs text-muted-foreground" translate="no">
					{displayLocation}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					{uri && <CopyPill label="Copy URI" value={uri} />}
					<CopyPill label="Copy key" value={objectKey} />
					{detail.data.snippet && <CopyPill label="Copy snippet" value={detail.data.snippet} />}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{detail.data.snippet && (
						<OpenInNotebookButton
							projectId={projectId}
							notebook={{
								title: `explore_${safeNotebookTitle(objectKey)}`,
								heading: displayLocation,
								description: `Explore ${displayLocation} via the ${integration.name} integration`,
								snippet: detail.data.snippet,
							}}
						/>
					)}
					{downloadAvailable && (
						<a
							href={downloadUrl}
							className="inline-flex h-9 touch-manipulation items-center justify-center gap-2 rounded-md border border-input bg-card px-3.5 text-[13px] font-medium shadow-xs transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
						>
							<Download className="size-4" aria-hidden />
							Download
						</a>
					)}
				</div>
			</div>
			<div className="flex flex-wrap gap-2">
				<Chip>{formatBytes(detail.data.size)}</Chip>
				{detail.data.content_type && <Chip>{detail.data.content_type}</Chip>}
				{detail.data.storage_class && <Chip>{detail.data.storage_class}</Chip>}
				{versionId && <Chip>version {versionId}</Chip>}
			</div>
			<Tabs defaultSelectedKey="metadata" className="flex flex-col gap-4">
				<TabList aria-label="Object details" className="flex border-b border-input">
					<Tab id="metadata" className={tabClass}>
						Metadata
					</Tab>
					{previewAvailable && (
						<Tab id="preview" className={tabClass}>
							Preview
						</Tab>
					)}
					{versionsAvailable && (
						<Tab id="versions" className={tabClass}>
							Versions
						</Tab>
					)}
				</TabList>
				<TabPanel id="metadata" className="flex flex-col gap-3">
					<MetadataRows
						values={{
							Size: formatBytes(detail.data.size),
							ETag: detail.data.etag,
							'Last modified': formatDateTime(detail.data.last_modified),
							'Content type': detail.data.content_type,
							'Content encoding': detail.data.content_encoding,
							'Cache control': detail.data.cache_control,
						}}
					/>
					{Object.keys(detail.data.metadata).length > 0 && (
						<MetadataRows values={detail.data.metadata} />
					)}
					{detail.data.checksums.length > 0 && (
						<MetadataRows
							values={Object.fromEntries(
								detail.data.checksums.map((checksum) => [
									`Checksum ${checksum.algorithm}`,
									checksum.value,
								]),
							)}
						/>
					)}
					{detail.data.tags_available ? (
						detail.data.tags && detail.data.tags.length > 0 ? (
							<MetadataRows
								values={Object.fromEntries(
									detail.data.tags.map((tag) => [`Tag ${tag.key}`, tag.value]),
								)}
							/>
						) : (
							<p className="text-xs text-muted-foreground">No object tags.</p>
						)
					) : (
						<p className="text-xs text-muted-foreground">
							Tags are unavailable with these credentials.
						</p>
					)}
				</TabPanel>
				{previewAvailable && (
					<TabPanel id="preview">
						<PreviewPanel
							preview={preview}
							input={{ bucket, key: objectKey, ...(versionId ? { version_id: versionId } : {}) }}
						/>
					</TabPanel>
				)}
				{versionsAvailable && (
					<TabPanel id="versions" className="flex flex-col gap-2">
						<Button
							size="sm"
							variant={!versionId ? 'primary' : 'default'}
							onPress={() => onVersion(undefined)}
						>
							Current object
						</Button>
						{versions.data?.pages
							.flatMap((page) => page.items)
							.map((item) => (
								<button
									key={`${item.kind}:${item.version_id ?? item.last_modified}`}
									type="button"
									disabled={item.kind === 'delete-marker'}
									onClick={() => onVersion(item.version_id)}
									className={cn(
										'flex touch-manipulation items-center justify-between rounded-md border px-3 py-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11',
										item.version_id === versionId && 'border-primary bg-primary/5',
									)}
								>
									<span>{item.kind === 'delete-marker' ? 'Delete marker' : item.version_id}</span>
									<span className="tabular-nums">
										{item.is_latest ? 'latest' : formatDateTime(item.last_modified)}
									</span>
								</button>
							))}
						{versions.error && (
							<p className="text-sm text-destructive">{errorMessage(versions.error)}</p>
						)}
						{versions.hasNextPage && (
							<Button onPress={() => void versions.fetchNextPage()}>Load more versions</Button>
						)}
					</TabPanel>
				)}
			</Tabs>
		</div>
	);
}

function PreviewPanel({
	preview,
	input,
}: {
	preview: ReturnType<typeof useObjectPreview>;
	input: { bucket: string; key: string; version_id?: string };
}) {
	if (!preview.data)
		return (
			<div className="flex flex-col items-start gap-2">
				<p className="text-sm text-muted-foreground">
					Content is fetched only when you request it.
				</p>
				<Button
					variant="primary"
					isDisabled={preview.isPending}
					onPress={() => preview.mutate({ ...input, limit: 20 })}
				>
					{preview.isPending ? 'Loading…' : 'Load preview'}
				</Button>
				{preview.error && <p className="text-sm text-destructive">{preview.error.message}</p>}
			</div>
		);
	const warnings = 'warnings' in preview.data ? preview.data.warnings : [];
	return (
		<div className="flex flex-col items-start gap-3">
			<div className="w-full">
				<PreviewResult value={preview.data} />
			</div>
			{warnings.length > 0 && (
				<ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
					{warnings.map((warning) => (
						<li key={warning}>{warning}</li>
					))}
				</ul>
			)}
			<Button
				isDisabled={preview.isPending}
				onPress={() => preview.mutate({ ...input, limit: 20 })}
			>
				{preview.isPending ? 'Loading…' : 'Reload preview'}
			</Button>
		</div>
	);
}

function PreviewResult({ value }: { value: IntegrationObjectPreview }) {
	if (value.kind === 'text')
		return (
			<pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">
				{value.text}
			</pre>
		);
	if (value.kind === 'image')
		return (
			<img
				src={withBasePath(value.content_url)}
				alt="Object preview"
				width={value.width ?? 1024}
				height={value.height ?? 768}
				loading="lazy"
				className="max-h-[32rem] max-w-full rounded-md border object-contain"
			/>
		);
	if (value.kind === 'unsupported')
		return <p className="text-sm text-muted-foreground">{value.reason}</p>;
	return (
		<TabularPreviewGrid columns={value.columns} rows={value.rows} truncated={value.truncated} />
	);
}

function MetadataRows({ values }: { values: Record<string, string | undefined> }) {
	return (
		<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
			{Object.entries(values)
				.filter(([, value]) => value !== undefined)
				.map(([name, value]) => (
					<div key={name} className="contents">
						<dt className="font-medium text-muted-foreground">{name}</dt>
						<dd className="break-all font-mono">{value}</dd>
					</div>
				))}
		</dl>
	);
}

/** Only the icon flips on copy; label, tooltip, and accessible name stay stable. */
function CopyPill({ label, value }: { label: string; value: string }) {
	const { copied, copy } = useCopyToClipboard();
	return (
		<Tooltip content={<span className="break-all font-mono text-[11px]">{value}</span>}>
			<AriaButton
				onPress={() => void copy(value)}
				className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-input bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-9"
			>
				{copied ? (
					<Check className="size-3.5 text-primary" aria-hidden />
				) : (
					<Copy className="size-3.5" aria-hidden />
				)}
				{label}
			</AriaButton>
		</Tooltip>
	);
}

function RowCopyAction({
	label,
	name,
	value,
	icon,
}: {
	label: string;
	name: string;
	value: string;
	icon: ReactNode;
}) {
	const { copied, copy } = useCopyToClipboard();
	return (
		<IconButton label={`${label} for ${name}`} tooltip={label} onPress={() => void copy(value)}>
			{copied ? <Check className="size-3.5 text-primary" aria-hidden /> : icon}
		</IconButton>
	);
}

function objectRootLabel(rootKind: ObjectRootKind): { singular: string; plural: string } {
	switch (rootKind) {
		case 'bucket':
			return { singular: 'bucket', plural: 'Buckets' };
		case 'container':
			return { singular: 'container', plural: 'Containers' };
		case 'unknown':
			return { singular: 'storage root', plural: 'Storage roots' };
		default:
			return logNever(rootKind, 'object root kind', {
				singular: 'storage root',
				plural: 'Storage roots',
			});
	}
}

function objectUri(uriScheme: ObjectUriScheme, bucket: string, key: string): string | null {
	switch (uriScheme) {
		case 's3':
		case 'gs':
		case 'az':
			return `${uriScheme}://${bucket}/${key}`;
		case 'unknown':
			return null;
		default:
			return logNever(uriScheme, 'object URI scheme', null);
	}
}

function prefixParts(prefix: string): { label: string; value: string }[] {
	let value = '';
	return prefix
		.split('/')
		.filter(Boolean)
		.map((label) => {
			value += `${label}/`;
			return { label, value };
		});
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes;
	let index = -1;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatDateTime(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
}

function objectFormat(name: string): 'data' | 'text' | 'image' | 'other' {
	const extension = name.split('.').at(-1)?.toLocaleLowerCase();
	if (extension && ['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'parquet'].includes(extension)) {
		return 'data';
	}
	if (
		extension &&
		['txt', 'log', 'md', 'py', 'js', 'ts', 'tsx', 'sql', 'yaml', 'yml'].includes(extension)
	) {
		return 'text';
	}
	if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
	return 'other';
}

function objectFormatLabel(name: string): string {
	const extension = name.split('.').at(-1)?.toLocaleUpperCase();
	return extension && extension.length <= 10 ? extension : 'Object';
}

function ObjectFilterSelect({
	label,
	name,
	value,
	onChange,
	children,
}: {
	label: string;
	name: string;
	value: string;
	onChange: (value: string) => void;
	children: ReactNode;
}) {
	return (
		<select
			aria-label={label}
			name={name}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className="h-9 cursor-pointer rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{children}
		</select>
	);
}

function safeNotebookTitle(key: string): string {
	return (
		(key.split('/').at(-1) ?? 'object').replaceAll(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'object'
	);
}

function objectSelectionLocation(bucket: string, prefix: string, key: string): string {
	return JSON.stringify([bucket, prefix, key]);
}

const tabClass =
	'cursor-pointer border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground outline-none data-[selected]:border-primary data-[selected]:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
