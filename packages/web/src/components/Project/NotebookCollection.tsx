import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileText, GitBranch } from 'lucide-react';
import type { NotebookEntry, ResolvedUser } from '@/types';
import { Chip, RowLink, UserLabel } from '@/components/ui';
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
				const { notebook } = item;
				const tags = tagsFor(notebook);
				return (
					<div className="flex min-w-0 items-center gap-3 max-sm:gap-2">
						{item.leading ?? <NotebookIcon notebook={notebook} />}
						<div className="min-w-0 flex-1">
							{notebook.status === 'deleted' ? (
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
							{(notebook.status !== 'active' || tags.length > 0) && (
								<div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
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
				if (notebook.status === 'deleted') {
					return (
						<div
							key={notebook.id}
							data-testid="notebook-row"
							className="col-span-full flex items-center gap-3 rounded-lg border bg-muted/20 p-4"
						>
							<NotebookIcon notebook={notebook} />
							<div className="min-w-0 flex-1">
								<NotebookName notebook={notebook} />
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
