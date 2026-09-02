import { useQuery } from '@tanstack/react-query';
import {
	createFinderStore,
	dirname,
	Finder,
	formatDate,
	formatFileSize,
	useFinder,
	useFinderStore,
} from '@marimo-team/react-finder';
import type { FileItem, FinderError } from '@marimo-team/react-finder';
import {
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	File,
	FileCode2,
	FilePlus2,
	Folder,
	FolderOpen,
	FolderPlus,
	Grid2X2,
	List,
	RefreshCw,
	TableProperties,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button as AriaButton, Input, Link, Size, ToggleButton } from 'react-aria-components';
import { ConfirmDialog, DialogModal, Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';
import { fetchWorkspaceAccess, workspaceAdapter } from './workspaceAdapter';
import { WorkspaceFilePreview } from './WorkspaceFilePreview';
import {
	canApplyWorkspaceOperation,
	isWorkspacePathProtected,
	workspaceAccessMessage,
} from './workspacePolicy';
import type { WorkspaceAccess } from './workspacePolicy';

type ViewMode = 'list' | 'grid' | 'table';

const controlClass =
	'inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground outline-none hover:bg-accent hover:text-accent-foreground data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring disabled:cursor-not-allowed disabled:opacity-40';
const iconControlClass = cn(controlClass, 'w-8 justify-center px-0');
const viewToggleClass =
	'flex size-8 items-center justify-center bg-background text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground data-[selected]:bg-primary/15 data-[selected]:text-primary data-[focus-visible]:z-10 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring';
const itemStateClass =
	'data-[hovered]:bg-accent/70 data-[selected]:bg-primary/10 data-[selected]:text-foreground data-[selected]:ring-1 data-[selected]:ring-inset data-[selected]:ring-primary/40 data-[selected]:data-[hovered]:bg-primary/15 data-[focus-visible]:ring-2 data-[focus-visible]:ring-inset data-[focus-visible]:ring-ring data-[dragging]:opacity-45 data-[cut]:opacity-50 data-[drop-target]:bg-primary/15 data-[drop-target]:ring-2 data-[drop-target]:ring-inset data-[drop-target]:ring-primary';
const itemClass = `group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none ${itemStateClass}`;
const treeItemClass = `${itemClass} py-1`;
const gridItemClass = `group flex h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-transparent p-2 text-center outline-none ${itemStateClass}`;
const tableColumnHeaderClass =
	'border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground';
const menuClass = 'min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg';
const menuItemClass =
	'cursor-default rounded-sm px-2 py-1.5 text-sm outline-none data-[focused]:bg-accent data-[disabled]:opacity-40';

function ItemIcon({
	item,
	open = false,
	className,
}: {
	item: FileItem;
	open?: boolean;
	className?: string;
}) {
	if (item.kind === 'directory') {
		const Icon = open ? FolderOpen : Folder;
		return <Icon className={cn('size-4 shrink-0 text-amber-500', className)} />;
	}
	return item.mimeType?.startsWith('text/') || /\.(py|json|toml|ya?ml|md)$/i.test(item.name) ? (
		<FileCode2 className={cn('size-4 shrink-0 text-blue-500', className)} />
	) : (
		<File className={cn('size-4 shrink-0 text-muted-foreground', className)} />
	);
}

function EditableItemName({
	item,
	isEditing,
	access,
	className,
}: {
	item: FileItem;
	isEditing: boolean;
	access: WorkspaceAccess;
	className?: string;
}) {
	return isEditing && !isWorkspacePathProtected(access, item.path, 'move') ? (
		<Finder.RenameInput className="min-w-0 flex-1">
			<Input className="w-full rounded border bg-background px-1 text-foreground outline-none" />
		</Finder.RenameInput>
	) : (
		<span className={cn('min-w-0 truncate', className)}>{item.name}</span>
	);
}

function itemType(item: FileItem): string {
	if (item.kind === 'directory') return 'Folder';
	return item.mimeType ?? 'File';
}

function itemModifiedAt(item: FileItem): string {
	return item.modifiedAt === undefined ? '—' : formatDate(item.modifiedAt);
}

function ExplorerItems({
	view,
	access,
	onOpen,
}: {
	view: ViewMode;
	access: WorkspaceAccess;
	onOpen: (item: FileItem) => void;
}) {
	const editingPath = useFinder((state) => state.editingPath);
	if (view === 'table') {
		return (
			<Finder.Table
				aria-label="Workspace files"
				dragAndDrop={access.writable}
				virtualized
				layoutOptions={{ rowHeight: 36, headingHeight: 36 }}
				className="block h-full w-full overflow-auto border-separate border-spacing-0 outline-none"
				style={{ scrollPaddingTop: 36 }}
			>
				<Finder.TableHeader className="w-full">
					<Finder.Column
						id="name"
						isRowHeader
						allowsSorting
						width="2fr"
						className={cn(tableColumnHeaderClass, 'text-left')}
					>
						Name
					</Finder.Column>
					<Finder.Column
						id="kind"
						allowsSorting
						width="1.25fr"
						className={cn(tableColumnHeaderClass, 'text-left')}
					>
						Type
					</Finder.Column>
					<Finder.Column
						id="size"
						allowsSorting
						width={88}
						className={cn(tableColumnHeaderClass, 'text-right')}
					>
						Size
					</Finder.Column>
					<Finder.Column
						id="modifiedAt"
						allowsSorting
						width={176}
						className={cn(tableColumnHeaderClass, 'text-left')}
					>
						Modified
					</Finder.Column>
				</Finder.TableHeader>
				<Finder.TableBody
					renderEmptyState={(status) => <EmptyFolder isLoading={status.isLoading} />}
				>
					{(item) => (
						<Finder.Item
							item={item}
							onAction={() => onOpen(item)}
							className={cn('outline-none', itemStateClass)}
							style={{ width: 'inherit', height: 'inherit' }}
						>
							<Finder.Cell className="border-b px-3 py-2 text-sm">
								<span className="flex min-w-0 items-center gap-2">
									<ItemIcon item={item} />
									<EditableItemName
										item={item}
										isEditing={editingPath === item.path}
										access={access}
										className="flex-1"
									/>
								</span>
							</Finder.Cell>
							<Finder.Cell className="truncate border-b px-3 py-2 text-xs text-muted-foreground">
								{itemType(item)}
							</Finder.Cell>
							<Finder.Cell className="border-b px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
								{item.kind === 'file' ? formatFileSize(item.size) : '—'}
							</Finder.Cell>
							<Finder.Cell className="border-b px-3 py-2 text-xs text-muted-foreground tabular-nums">
								{itemModifiedAt(item)}
							</Finder.Cell>
						</Finder.Item>
					)}
				</Finder.TableBody>
			</Finder.Table>
		);
	}

	const grid = view === 'grid';
	return (
		<Finder.List
			key={view}
			aria-label="Workspace files"
			layout={grid ? 'grid' : 'stack'}
			dragAndDrop={access.writable}
			virtualized
			layoutOptions={
				grid ? { minItemSize: new Size(112, 112), minSpace: new Size(8, 8) } : { rowSize: 44 }
			}
			className={cn('block h-full overflow-auto outline-none', grid && 'p-3')}
			renderEmptyState={(status) => <EmptyFolder isLoading={status.isLoading} />}
		>
			{(item) => (
				<Finder.Item
					item={item}
					onAction={() => onOpen(item)}
					className={grid ? gridItemClass : itemClass}
				>
					{({ isEditing }) => (
						<>
							<ItemIcon item={item} className={grid ? 'size-8' : undefined} />
							{grid ? (
								<>
									<EditableItemName
										item={item}
										isEditing={isEditing}
										access={access}
										className="w-full text-xs font-medium"
									/>
									<span className="w-full truncate text-[11px] text-muted-foreground">
										{item.kind === 'file' ? formatFileSize(item.size) : itemType(item)}
									</span>
									<span className="w-full truncate text-[10px] text-muted-foreground tabular-nums">
										{itemModifiedAt(item)}
									</span>
								</>
							) : (
								<>
									<div className="min-w-0 flex-1">
										<EditableItemName item={item} isEditing={isEditing} access={access} />
										<div className="truncate text-[11px] text-muted-foreground">
											{itemType(item)}
										</div>
									</div>
									<div className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
										<div>{item.kind === 'file' ? formatFileSize(item.size) : '—'}</div>
										<div>{itemModifiedAt(item)}</div>
									</div>
								</>
							)}
						</>
					)}
				</Finder.Item>
			)}
		</Finder.List>
	);
}

function EmptyFolder({ isLoading }: { isLoading: boolean }) {
	return (
		<div className="p-8 text-center text-sm text-muted-foreground">
			{isLoading ? 'Loading folder…' : 'This folder is empty.'}
		</div>
	);
}

function Toolbar({
	view,
	setView,
	access,
	onDelete,
}: {
	view: ViewMode;
	setView: (view: ViewMode) => void;
	access: WorkspaceAccess;
	onDelete: (paths: string[]) => void;
}) {
	const selection = useFinder((state) => [...state.selectedPaths]);
	const canMove = canApplyWorkspaceOperation(access, selection, 'move');
	const canDelete = canApplyWorkspaceOperation(access, selection, 'delete');
	return (
		<Finder.Toolbar className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-muted/30 p-2">
			<div className="flex items-center gap-1">
				<span title="Back">
					<Finder.Button action="back" aria-label="Back" className={iconControlClass}>
						<ArrowLeft className="size-4" aria-hidden />
					</Finder.Button>
				</span>
				<span title="Forward">
					<Finder.Button action="forward" aria-label="Forward" className={iconControlClass}>
						<ArrowRight className="size-4" aria-hidden />
					</Finder.Button>
				</span>
				<span title="Parent folder">
					<Finder.Button action="up" aria-label="Parent folder" className={iconControlClass}>
						<ArrowUp className="size-4" aria-hidden />
					</Finder.Button>
				</span>
				<Tooltip content="Refresh">
					<Finder.Button action="refresh" aria-label="Refresh" className={iconControlClass}>
						<RefreshCw className="size-4" aria-hidden />
					</Finder.Button>
				</Tooltip>
			</div>
			<span className="mx-1 h-5 w-px bg-border" />
			<Finder.Button action="newFile" className={controlClass}>
				<FilePlus2 className="mr-1.5 size-3.5" aria-hidden />
				New File
			</Finder.Button>
			<Finder.Button action="newFolder" className={controlClass}>
				<FolderPlus className="mr-1.5 size-3.5" aria-hidden />
				New Folder
			</Finder.Button>
			<Finder.Button action="rename" className={controlClass} isDisabled={!canMove}>
				Rename
			</Finder.Button>
			<AriaButton
				className={cn(controlClass, 'text-destructive')}
				isDisabled={!canDelete}
				onPress={() => onDelete(selection)}
			>
				Delete
			</AriaButton>
			<Finder.SearchInput className="group ml-1 min-w-40 flex-1">
				<Input
					className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					placeholder="Search workspace…"
				/>
			</Finder.SearchInput>
			<fieldset aria-label="Layout" className="flex overflow-hidden rounded-md border border-input">
				<span className="inline-flex" title="List view">
					<ToggleButton
						isSelected={view === 'list'}
						onPress={() => setView('list')}
						aria-label="List view"
						className={viewToggleClass}
					>
						<List className="size-4" aria-hidden />
					</ToggleButton>
				</span>
				<span className="inline-flex" title="Grid view">
					<ToggleButton
						isSelected={view === 'grid'}
						onPress={() => setView('grid')}
						aria-label="Grid view"
						className={viewToggleClass}
					>
						<Grid2X2 className="size-4" aria-hidden />
					</ToggleButton>
				</span>
				<span className="inline-flex" title="Table view">
					<ToggleButton
						isSelected={view === 'table'}
						onPress={() => setView('table')}
						aria-label="Table view"
						className={viewToggleClass}
					>
						<TableProperties className="size-4" aria-hidden />
					</ToggleButton>
				</span>
			</fieldset>
		</Finder.Toolbar>
	);
}

/** The one confirmation every delete path (toolbar, context menu, Delete key) goes through. */
function DeleteConfirmation({ paths, onClose }: { paths: string[] | null; onClose: () => void }) {
	const store = useFinderStore();
	const count = paths?.length ?? 0;
	return (
		<ConfirmDialog
			isOpen={paths !== null}
			onClose={onClose}
			title={count === 1 ? 'Delete this entry?' : `Delete ${count} entries?`}
			description="Directories and their contents will be deleted permanently."
			confirmLabel="Delete"
			onConfirm={() => {
				if (paths) void store.getState().deleteItems(paths);
				onClose();
			}}
		/>
	);
}

function Breadcrumbs() {
	return (
		<Finder.Breadcrumbs className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-2 text-sm">
			{(crumb) => (
				<Finder.Breadcrumb crumb={crumb} className="flex items-center gap-1">
					{!crumb.isRoot ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
					<Link className="cursor-pointer rounded px-1 outline-none hover:bg-accent data-[focus-visible]:ring-2">
						{crumb.isRoot ? 'Workspace' : crumb.name}
					</Link>
				</Finder.Breadcrumb>
			)}
		</Finder.Breadcrumbs>
	);
}

function ContextMenu({
	access,
	onDelete,
}: {
	access: WorkspaceAccess;
	onDelete: (paths: string[]) => void;
}) {
	return (
		<Finder.ContextMenu className={menuClass} popoverProps={{ className: 'z-[80]' }}>
			{({ target, selection, close }) => {
				const targets =
					target && !selection.some((item) => item.path === target.path) ? [target] : selection;
				const paths = targets.map((item) => item.path);
				const canMove = canApplyWorkspaceOperation(access, paths, 'move');
				const canDelete = canApplyWorkspaceOperation(access, paths, 'delete');
				return (
					<>
						{target ? (
							<Finder.MenuItem action="open" className={menuItemClass}>
								Open
							</Finder.MenuItem>
						) : null}
						{target ? (
							<Finder.MenuItem action="rename" isDisabled={!canMove} className={menuItemClass}>
								Rename
							</Finder.MenuItem>
						) : null}
						<Finder.MenuSeparator className="my-1 h-px bg-border" />
						<Finder.MenuItem action="copy" className={menuItemClass}>
							Copy
						</Finder.MenuItem>
						<Finder.MenuItem action="cut" isDisabled={!canMove} className={menuItemClass}>
							Cut
						</Finder.MenuItem>
						<Finder.MenuItem action="paste" className={menuItemClass}>
							Paste
						</Finder.MenuItem>
						<Finder.MenuSeparator className="my-1 h-px bg-border" />
						<Finder.MenuItem action="newFile" className={menuItemClass}>
							New file
						</Finder.MenuItem>
						<Finder.MenuItem action="newFolder" className={menuItemClass}>
							New folder
						</Finder.MenuItem>
						{target ? (
							<Finder.MenuItem
								isDisabled={!canDelete}
								className={cn(menuItemClass, 'text-destructive')}
								onAction={() => {
									close();
									onDelete(paths);
								}}
							>
								Delete
							</Finder.MenuItem>
						) : null}
					</>
				);
			}}
		</Finder.ContextMenu>
	);
}

function DeleteShortcut({
	access,
	onDelete,
}: {
	access: WorkspaceAccess;
	onDelete: (paths: string[]) => void;
}) {
	const store = useFinderStore();
	useEffect(() => {
		const deleteSelected = (event: KeyboardEvent) => {
			if (event.key !== 'Delete' || !access.writable) return;
			const target = event.target;
			if (!(target instanceof HTMLElement) || !target.closest('[data-finder]')) return;
			if (target.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
			const paths = [...store.getState().selectedPaths];
			if (!canApplyWorkspaceOperation(access, paths, 'delete')) return;
			event.preventDefault();
			onDelete(paths);
		};
		window.addEventListener('keydown', deleteSelected);
		return () => window.removeEventListener('keydown', deleteSelected);
	}, [access, onDelete, store]);
	return null;
}

function AccessBanner({ access }: { access: WorkspaceAccess }) {
	const message = workspaceAccessMessage(access);
	if (!message) return null;
	return (
		<div className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
			{message}
		</div>
	);
}

function Explorer({
	projectId,
	notebookId,
	access,
	onDirtyChange,
}: {
	projectId: string;
	notebookId: string;
	access: WorkspaceAccess;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const adapter = useMemo(
		() => workspaceAdapter(projectId, notebookId, access),
		[access, notebookId, projectId],
	);
	const [view, setView] = useState<ViewMode>('list');
	const [openPath, setOpenPath] = useState<string | null>(null);
	const [deleteRequest, setDeleteRequest] = useState<string[] | null>(null);
	const requestDelete = useCallback((paths: string[]) => {
		if (paths.length > 0) setDeleteRequest(paths);
	}, []);
	const clearDeleteRequest = useCallback(() => setDeleteRequest(null), []);
	const dirty = useRef(false);
	const [error, setError] = useState<FinderError | null>(null);
	const activeCollection = useRef<'tree' | 'content'>('content');
	const [store] = useState(() =>
		createFinderStore({
			adapter,
			showHidden: true,
			onError: setError,
		}),
	);
	useEffect(() => () => store.destroy(), [store]);
	const setDirtyState = useCallback(
		(next: boolean) => {
			dirty.current = next;
			onDirtyChange(next);
		},
		[onDirtyChange],
	);
	const open = useCallback(
		(item: FileItem) => {
			if (item.kind !== 'file') return;
			if (dirty.current && !window.confirm('Discard unsaved changes and open another file?'))
				return;
			setDirtyState(false);
			setOpenPath(item.path);
		},
		[setDirtyState],
	);
	const navigateFromTreeSelection = useCallback(
		(items: FileItem[]) => {
			if (activeCollection.current !== 'tree') return;
			const item = items[0];
			if (!item) return;
			if (item.kind === 'directory') {
				if (store.getState().currentPath === item.path) {
					store.getState().clearSelection();
					return;
				}
				void store.getState().navigate(item.path);
				return;
			}
			const targetPath = dirname(item.path);
			if (store.getState().currentPath === targetPath) return;
			void store
				.getState()
				.navigate(targetPath)
				.then(() => store.getState().setSelection([item.path]));
		},
		[store],
	);

	return (
		<Finder
			store={store}
			onOpen={open}
			onSelectionChange={navigateFromTreeSelection}
			shortcuts={{ delete: null }}
			className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)_minmax(280px,38%)]"
		>
			<aside
				className="min-h-0 overflow-hidden border-r bg-muted/20 p-2"
				onFocusCapture={() => (activeCollection.current = 'tree')}
				onPointerDownCapture={() => (activeCollection.current = 'tree')}
			>
				<Finder.Tree
					aria-label="Workspace tree"
					dragAndDrop={access.writable}
					virtualized
					layoutOptions={{ rowSize: 28 }}
					className="block h-full overflow-auto outline-none"
				>
					{(item) => (
						<Finder.Item item={item} className={treeItemClass}>
							{({ hasChildItems, isExpanded, isLoading, level }) => (
								<div
									className="flex min-w-0 items-center gap-1"
									style={{ paddingInlineStart: (level - 1) * 12 }}
								>
									{hasChildItems ? (
										<AriaButton
											slot="chevron"
											aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
											className="rounded outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
										>
											{isLoading ? (
												'…'
											) : isExpanded ? (
												<ChevronDown className="size-3" aria-hidden />
											) : (
												<ChevronRight className="size-3" aria-hidden />
											)}
										</AriaButton>
									) : (
										<span className="w-3" />
									)}
									<ItemIcon item={item} open={isExpanded} />
									<span className="truncate">{item.name}</span>
								</div>
							)}
						</Finder.Item>
					)}
				</Finder.Tree>
			</aside>
			<section
				className="flex min-h-0 min-w-0 flex-col border-r"
				onFocusCapture={() => (activeCollection.current = 'content')}
				onPointerDownCapture={() => (activeCollection.current = 'content')}
			>
				<Toolbar view={view} setView={setView} access={access} onDelete={requestDelete} />
				<Breadcrumbs />
				{error ? (
					<div className="flex items-center justify-between border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
						<span>{error.message}</span>
						<AriaButton className="underline" onPress={() => setError(null)}>
							Dismiss
						</AriaButton>
					</div>
				) : null}
				<Finder.DropZone className="min-h-0 flex-1 overflow-hidden data-[drop-target]:bg-primary/5 data-[drop-target]:ring-2 data-[drop-target]:ring-inset data-[drop-target]:ring-primary">
					<ExplorerItems view={view} access={access} onOpen={open} />
				</Finder.DropZone>
				<Finder.State>
					{({ items, selectedItems, clipboard, currentPath, isLoading, hasMore }) => (
						<div className="flex h-7 shrink-0 items-center gap-3 border-t px-2 text-[11px] text-muted-foreground">
							<span>{items.length} items</span>
							{hasMore ? (
								<Finder.Button action="loadMore" className="underline">
									Load more
								</Finder.Button>
							) : null}
							{selectedItems.length > 0 ? <span>{selectedItems.length} selected</span> : null}
							{clipboard ? (
								<span>
									{clipboard.paths.length} {clipboard.mode === 'cut' ? 'cut' : 'copied'}
								</span>
							) : null}
							{isLoading ? <span>Loading…</span> : null}
							<span className="ml-auto truncate">{currentPath}</span>
						</div>
					)}
				</Finder.State>
			</section>
			<section className="min-h-0 min-w-0 overflow-hidden bg-card">
				<WorkspaceFilePreview path={openPath} access={access} onDirtyChange={setDirtyState} />
			</section>
			<ContextMenu access={access} onDelete={requestDelete} />
			<DeleteShortcut access={access} onDelete={requestDelete} />
			<DeleteConfirmation paths={deleteRequest} onClose={clearDeleteRequest} />
		</Finder>
	);
}

export interface WorkspaceBrowserDialogProps {
	projectId: string;
	notebookId: string;
	notebookTitle: string;
	isOpen: boolean;
	onClose: () => void;
}

export default function WorkspaceBrowserDialog({
	projectId,
	notebookId,
	notebookTitle,
	isOpen,
	onClose,
}: WorkspaceBrowserDialogProps): ReactElement {
	const dirty = useRef(false);
	const setDirty = useCallback((next: boolean) => {
		dirty.current = next;
	}, []);
	const access = useQuery({
		queryKey: ['workspace-access', projectId, notebookId],
		queryFn: ({ signal }) => fetchWorkspaceAccess(projectId, notebookId, signal),
		enabled: isOpen,
		staleTime: 0,
	});
	const close = () => {
		if (dirty.current && !window.confirm('Discard unsaved workspace changes?')) return;
		dirty.current = false;
		onClose();
	};

	return (
		<DialogModal
			isOpen={isOpen}
			onClose={close}
			title={`Browse files · ${notebookTitle}`}
			width="screen"
			contentClassName="h-full overflow-hidden p-0"
		>
			{access.isPending ? (
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					Loading workspace…
				</div>
			) : access.isError || !access.data ? (
				<div className="p-5 text-sm text-destructive">Could not load workspace access.</div>
			) : (
				<div className="flex h-full min-h-0 flex-col">
					<AccessBanner access={access.data} />
					<Explorer
						key={`${notebookId}:${String(access.data.writable)}`}
						projectId={projectId}
						notebookId={notebookId}
						access={access.data}
						onDirtyChange={setDirty}
					/>
				</div>
			)}
		</DialogModal>
	);
}
