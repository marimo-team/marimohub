import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileText, GitBranch } from 'lucide-react';
import type { NotebookEntry, ResolvedUser } from '@/types';
import { Chip, RowLink, Tooltip, UserLabel } from '@/components/ui';
import { DataTable } from '@/components/ui/DataTable';
import type { DataTableColumn } from '@/components/ui/DataTable';
import { formatRelative } from '@/lib/time';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { NotebookTags } from './NotebookTags';

export interface NotebookCollectionItem {
	notebook: NotebookEntry;
	user?: ResolvedUser;
	usersLoading: boolean;
	to: string;
	leading?: ReactNode;
	preview?: ReactNode;
	showSessions: boolean;
	sessions: ReactNode;
	actions: ReactNode;
	/** Destination project name (or ID) while a move is pending. */
	movingTo?: string;
}

function MovingBadge({ destination }: { destination: string }) {
	return (
		<Tooltip content={`Moving to ${destination}`}>
			<button
				type="button"
				aria-label={`Moving to ${destination}`}
				className="flex shrink-0 cursor-help items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300"
			>
				Moving
			</button>
		</Tooltip>
	);
}

// A moving notebook cannot be opened until the move publishes or is cancelled.
function isOpenable(item: NotebookCollectionItem): boolean {
	return item.notebook.status !== 'deleted' && item.movingTo === undefined;
}

function NotebookName({
	notebook,
	showStatus = true,
}: {
	notebook: NotebookEntry;
	showStatus?: boolean;
}) {
	return (
		<div className="flex min-w-0 items-center gap-2 text-sm">
			<span className="truncate font-medium" title={notebook.title}>
				{notebook.title}
			</span>
			{showStatus && notebook.status !== 'active' && <Chip>{notebook.status}</Chip>}
		</div>
	);
}

function NotebookAuthor({ item }: { item: NotebookCollectionItem }) {
	return (
		<UserLabel
			user={item.user}
			fallbackId={item.notebook.author}
			loading={item.usersLoading}
			className="block min-w-0 text-xs text-muted-foreground"
		/>
	);
}

function NotebookUpdated({ notebook }: { notebook: NotebookEntry }) {
	return (
		<time
			dateTime={notebook.updated_at}
			title={new Date(notebook.updated_at).toLocaleString()}
			className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
		>
			{formatRelative(notebook.updated_at)}
		</time>
	);
}

function NotebookIcon({ notebook }: { notebook: NotebookEntry }) {
	return (
		<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
			{notebook.source_type === 'git' ? (
				<GitBranch className="size-4" aria-hidden="true" />
			) : (
				<FileText className="size-4" aria-hidden="true" />
			)}
		</span>
	);
}

function tagsFor(notebook: NotebookEntry) {
	return notebook.tags.filter((tag) => notebook.status === 'active' || tag !== notebook.status);
}

function notebookColumns(compact: boolean): DataTableColumn<NotebookCollectionItem>[] {
	return [
		{
			id: 'name',
			header: 'Notebook',
			cell: (item) => {
				const { notebook, movingTo } = item;
				const tags = tagsFor(notebook);
				return (
					<div className="flex min-w-0 items-center gap-3 max-sm:gap-2">
						{item.leading ?? <NotebookIcon notebook={notebook} />}
						<div className="min-w-0 flex-1">
							{!isOpenable(item) ? (
								<NotebookName notebook={notebook} showStatus={false} />
							) : (
								<Link
									to={item.to}
									state={{ title: notebook.title }}
									aria-label={notebook.title}
									className="block rounded py-0.5 max-md:py-3 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
								>
									<NotebookName notebook={notebook} showStatus={false} />
								</Link>
							)}
							{(notebook.status !== 'active' || movingTo !== undefined || tags.length > 0) && (
								<div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
									{movingTo !== undefined && <MovingBadge destination={movingTo} />}
									{notebook.status !== 'active' && <Chip>{notebook.status}</Chip>}
									{tags.length > 0 && (
										<NotebookTags
											tags={tags}
											title={notebook.title}
											className="min-w-0 max-w-full shrink md:w-auto"
										/>
									)}
								</div>
							)}
							{compact && item.showSessions && (
								<div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
									{item.sessions}
								</div>
							)}
						</div>
					</div>
				);
			},
		},
		{
			id: 'sessions',
			header: 'Sessions',
			className: 'hidden w-24 sm:table-cell',
			cell: (item) => <div className="flex flex-wrap items-center gap-3">{item.sessions}</div>,
		},
		{
			id: 'author',
			header: 'Author',
			className: 'hidden w-40 lg:table-cell',
			cell: (item) => <NotebookAuthor item={item} />,
		},
		{
			id: 'updated',
			header: 'Updated',
			align: 'right',
			className: 'w-24 max-sm:w-20',
			cell: ({ notebook }) => <NotebookUpdated notebook={notebook} />,
		},
		{
			id: 'actions',
			header: <span className="sr-only">Actions</span>,
			className: 'w-24 max-sm:w-16',
			cell: (item) => (
				<div className="flex flex-wrap items-center justify-end gap-1">{item.actions}</div>
			),
		},
	];
}

export function NotebookCollection({
	items,
	gallery,
}: {
	items: NotebookCollectionItem[];
	gallery: boolean;
}) {
	const compact = useMediaQuery('(max-width: 639px)');
	if (!gallery) {
		const columns = notebookColumns(compact);
		const showSessions = items.some((item) => item.showSessions);
		return (
			<DataTable
				label="Notebooks"
				items={items}
				columns={
					showSessions && !compact ? columns : columns.filter((column) => column.id !== 'sessions')
				}
				getRowKey={(item) => item.notebook.id}
				rowTestId="notebook-row"
				rowClassName={(item) => (item.notebook.status === 'deleted' ? 'bg-muted/20' : undefined)}
			/>
		);
	}

	// ListResults supplies the gallery grid.
	return (
		<>
			{items.map((item) => {
				const { notebook } = item;
				if (!isOpenable(item)) {
					return (
						<div
							key={notebook.id}
							data-testid="notebook-row"
							className="col-span-full flex items-center gap-3 rounded-lg border bg-muted/20 p-4"
						>
							<NotebookIcon notebook={notebook} />
							<div className="flex min-w-0 flex-1 items-center gap-2">
								<NotebookName notebook={notebook} />
								{item.movingTo !== undefined && <MovingBadge destination={item.movingTo} />}
							</div>
							<NotebookTags tags={tagsFor(notebook)} title={notebook.title} />
							<div className="hidden min-w-0 max-w-32 items-center gap-1 text-xs text-muted-foreground sm:flex">
								<span>by</span>
								<NotebookAuthor item={item} />
							</div>
							<NotebookUpdated notebook={notebook} />
							{item.actions}
						</div>
					);
				}
				return (
					<RowLink
						key={notebook.id}
						testId="notebook-row"
						card
						preview={item.preview}
						to={item.to}
						state={{ title: notebook.title }}
						label={notebook.title}
						leading={item.leading}
						actions={item.actions}
						trailing={
							<>
								<NotebookTags tags={tagsFor(notebook)} title={notebook.title} />
								<div className="flex w-full min-w-0 items-center gap-3">
									{item.sessions}
									<div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
										<span>by</span>
										<NotebookAuthor item={item} />
									</div>
									<NotebookUpdated notebook={notebook} />
								</div>
							</>
						}
					>
						<NotebookName notebook={notebook} />
					</RowLink>
				);
			})}
		</>
	);
}
