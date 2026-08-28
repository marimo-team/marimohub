import { useQuery } from '@tanstack/react-query';
import {
	Finder,
	formatDate,
	formatFileSize,
	useFinder,
	useFinderStore,
} from '@marimo-team/react-finder';
import type { FileItem, FinderError } from '@marimo-team/react-finder';
import {
	ChevronDown,
	ChevronRight,
	File,
	FileCode2,
	Folder,
	FolderOpen,
	Grid2X2,
	List,
	TableProperties,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
	Button as AriaButton,
	Dialog,
	DialogTrigger,
	Heading,
	Input,
	Link,
	Modal,
	ModalOverlay,
	Size,
	ToggleButton,
	ToggleButtonGroup,
} from 'react-aria-components';
import { Button, DialogModal } from '@/components/ui';
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
	'h-8 rounded-md border border-input bg-background px-2.5 text-xs font-medium outline-none hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40';
const itemClass =
	'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[hovered]:bg-accent data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[cut]:opacity-50 data-[drop-target]:ring-2 data-[drop-target]:ring-primary';
const treeItemClass = `${itemClass} py-1`;
const gridItemClass =
	'group flex h-24 flex-col items-center justify-center gap-2 rounded-lg border border-transparent p-2 text-center outline-none data-[hovered]:bg-accent data-[selected]:border-primary data-[selected]:bg-primary/10 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[drop-target]:ring-2 data-[drop-target]:ring-primary';
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

function ExplorerItems({ view, access }: { view: ViewMode; access: WorkspaceAccess }) {
	if (view === 'table') {
		return (
			<Finder.Table
				dragAndDrop={access.writable}
				virtualized
				layoutOptions={{ rowHeight: 36, headingHeight: 36 }}
				className="block h-full overflow-auto border-separate border-spacing-0 outline-none"
				style={{ scrollPaddingTop: 36 }}
			>
				<Finder.TableHeader className="w-full">
					<Finder.Column
						id="name"
						isRowHeader
						allowsSorting
						className="sticky top-0 bg-card p-2 text-left text-xs"
					>
						Name
					</Finder.Column>
					<Finder.Column
						id="size"
						allowsSorting
						className="sticky top-0 w-24 bg-card p-2 text-right text-xs"
					>
						Size
					</Finder.Column>
					<Finder.Column
						id="modifiedAt"
						allowsSorting
						className="sticky top-0 w-44 bg-card p-2 text-left text-xs"
					>
						Modified
					</Finder.Column>
				</Finder.TableHeader>
				<Finder.TableBody renderEmptyState={() => <EmptyFolder />}>
					{(item) => (
						<Finder.Item
							item={item}
							className="outline-none data-[selected]:bg-primary/10 data-[hovered]:bg-accent"
							style={{ width: 'inherit', height: 'inherit' }}
						>
							<Finder.Cell className="border-b p-2 text-sm">
								<span className="flex items-center gap-2">
									<ItemIcon item={item} />
									{item.name}
								</span>
							</Finder.Cell>
							<Finder.Cell className="border-b p-2 text-right text-xs text-muted-foreground">
								{item.kind === 'file' ? formatFileSize(item.size) : '—'}
							</Finder.Cell>
							<Finder.Cell className="border-b p-2 text-xs text-muted-foreground">
								{formatDate(item.modifiedAt)}
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
			layout={grid ? 'grid' : 'stack'}
			dragAndDrop={access.writable}
			virtualized
			layoutOptions={
				grid ? { minItemSize: new Size(112, 96), minSpace: new Size(8, 8) } : { rowSize: 36 }
			}
			className={cn('block h-full overflow-auto outline-none', grid && 'p-3')}
			renderEmptyState={() => <EmptyFolder />}
		>
			{(item) => (
				<Finder.Item item={item} className={grid ? gridItemClass : itemClass}>
					{({ isEditing }) => (
						<>
							<ItemIcon item={item} className={grid ? 'size-8' : undefined} />
							{isEditing && !isWorkspacePathProtected(access, item.path, 'move') ? (
								<Finder.RenameInput className="min-w-0 flex-1">
									<Input className="w-full rounded border bg-background px-1 text-foreground outline-none" />
								</Finder.RenameInput>
							) : (
								<span className={cn('min-w-0 truncate', grid ? 'w-full text-xs' : 'flex-1')}>
									{item.name}
								</span>
							)}
							{!grid && item.kind === 'file' ? (
								<span className="text-xs text-muted-foreground">{formatFileSize(item.size)}</span>
							) : null}
						</>
					)}
				</Finder.Item>
			)}
		</Finder.List>
	);
}

function EmptyFolder() {
	return <div className="p-8 text-center text-sm text-muted-foreground">Empty folder</div>;
}

function Toolbar({
	view,
	setView,
	access,
}: {
	view: ViewMode;
	setView: (view: ViewMode) => void;
	access: WorkspaceAccess;
}) {
	const selection = useFinder((state) => [...state.selectedPaths]);
	const canMove = canApplyWorkspaceOperation(access, selection, 'move');
	const canDelete = canApplyWorkspaceOperation(access, selection, 'delete');
	return (
		<Finder.Toolbar className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-muted/30 p-2">
			<Finder.Button action="back" className={controlClass}>
				←
			</Finder.Button>
			<Finder.Button action="forward" className={controlClass}>
				→
			</Finder.Button>
			<Finder.Button action="up" className={controlClass}>
				↑
			</Finder.Button>
			<Finder.Button action="refresh" className={controlClass}>
				Refresh
			</Finder.Button>
			<span className="mx-1 h-5 w-px bg-border" />
			<Finder.Button action="newFile" className={controlClass}>
				New file
			</Finder.Button>
			<Finder.Button action="newFolder" className={controlClass}>
				New folder
			</Finder.Button>
			<Finder.Button action="rename" className={controlClass} isDisabled={!canMove}>
				Rename
			</Finder.Button>
			<DeleteButton isDisabled={!canDelete} />
			<Finder.SearchInput className="group ml-1 min-w-40 flex-1">
				<Input
					className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					placeholder="Search workspace…"
				/>
			</Finder.SearchInput>
			<ToggleButtonGroup
				selectionMode="single"
				disallowEmptySelection
				selectedKeys={[view]}
				onSelectionChange={(keys) => {
					const next = [...keys][0];
					if (next === 'list' || next === 'grid' || next === 'table') setView(next);
				}}
				className="flex gap-1"
			>
				<ToggleButton id="list" aria-label="List view" className={controlClass}>
					<List className="size-4" />
				</ToggleButton>
				<ToggleButton id="grid" aria-label="Grid view" className={controlClass}>
					<Grid2X2 className="size-4" />
				</ToggleButton>
				<ToggleButton id="table" aria-label="Table view" className={controlClass}>
					<TableProperties className="size-4" />
				</ToggleButton>
			</ToggleButtonGroup>
		</Finder.Toolbar>
	);
}

function DeleteButton({ isDisabled }: { isDisabled: boolean }) {
	return (
		<DialogTrigger>
			<Finder.Button
				action="delete"
				trigger
				className={cn(controlClass, 'text-destructive')}
				isDisabled={isDisabled}
			>
				Delete
			</Finder.Button>
			<ModalOverlay className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
				<Modal className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl">
					<Dialog className="outline-none">
						{({ close }) => (
							<>
								<Heading slot="title" className="font-semibold">
									Delete selected files?
								</Heading>
								<p className="mt-2 text-sm text-muted-foreground">
									Directories and their contents will be deleted permanently.
								</p>
								<div className="mt-5 flex justify-end gap-2">
									<Button onPress={close}>Cancel</Button>
									<Finder.Button
										action="delete"
										className="h-9 rounded-md bg-destructive px-3 text-sm text-white"
										onPress={close}
									>
										Delete
									</Finder.Button>
								</div>
							</>
						)}
					</Dialog>
				</Modal>
			</ModalOverlay>
		</DialogTrigger>
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

function ContextMenu({ access }: { access: WorkspaceAccess }) {
	const store = useFinderStore();
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
									if (window.confirm('Delete the selected workspace entries?')) {
										void store.getState().deleteItems(targets.map((item) => item.path));
									}
									close();
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

function ConfirmedDeleteShortcut({ access }: { access: WorkspaceAccess }) {
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
			if (window.confirm('Delete the selected workspace entries?')) {
				void store.getState().deleteItems(paths);
			}
		};
		window.addEventListener('keydown', deleteSelected);
		return () => window.removeEventListener('keydown', deleteSelected);
	}, [access, store]);
	return null;
}

function AccessBanner({ access }: { access: WorkspaceAccess }) {
	return (
		<div className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
			{workspaceAccessMessage(access)}
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
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState<FinderError | null>(null);
	const setDirtyState = useCallback(
		(next: boolean) => {
			setDirty(next);
			onDirtyChange(next);
		},
		[onDirtyChange],
	);
	const open = (item: FileItem) => {
		if (item.kind !== 'file') return;
		if (dirty && !window.confirm('Discard unsaved changes and open another file?')) return;
		setDirtyState(false);
		setOpenPath(item.path);
	};

	return (
		<Finder
			adapter={adapter}
			onOpen={open}
			onError={setError}
			shortcuts={{ delete: null }}
			className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)_minmax(280px,38%)]"
		>
			<aside className="min-h-0 overflow-hidden border-r bg-muted/20 p-2">
				<Finder.Tree
					navigateOnSelect
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
										<AriaButton slot="chevron" className="rounded outline-none">
											{isLoading ? (
												'…'
											) : isExpanded ? (
												<ChevronDown className="size-3" />
											) : (
												<ChevronRight className="size-3" />
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
			<section className="flex min-h-0 min-w-0 flex-col border-r">
				<Toolbar view={view} setView={setView} access={access} />
				<Breadcrumbs />
				{error ? (
					<div className="flex items-center justify-between border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
						<span>{error.message}</span>
						<AriaButton className="underline" onPress={() => setError(null)}>
							Dismiss
						</AriaButton>
					</div>
				) : null}
				<Finder.DropZone className="min-h-0 flex-1 overflow-hidden data-[drop-target]:ring-2 data-[drop-target]:ring-inset data-[drop-target]:ring-primary">
					<ExplorerItems view={view} access={access} />
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
			<ContextMenu access={access} />
			<ConfirmedDeleteShortcut access={access} />
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
	const [dirty, setDirty] = useState(false);
	const access = useQuery({
		queryKey: ['workspace-access', projectId, notebookId],
		queryFn: ({ signal }) => fetchWorkspaceAccess(projectId, notebookId, signal),
		enabled: isOpen,
		staleTime: 0,
	});
	const close = () => {
		if (dirty && !window.confirm('Discard unsaved workspace changes?')) return;
		setDirty(false);
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
