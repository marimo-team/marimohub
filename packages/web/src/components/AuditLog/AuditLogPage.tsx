import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { Check, Copy, FilterX, RefreshCw, ScrollText } from 'lucide-react';
import { Button, EmptyState, Skeleton, TextField, UserLabel } from '@/components/ui';
import { useAuditLogsQuery, useUsersQuery } from '@/api/hooks';
import type { AuditLogFilters } from '@/api/hooks';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { cn } from '@/lib/utils';
import type { AuditLogEntry, ResolvedUser } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 30;

function defaultFilters(): AuditLogFilters {
	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
	return { from, to, event: '', actor: '', projectId: '' };
}

function rangeError(filters: AuditLogFilters): string | null {
	if (!filters.from || !filters.to) return 'Choose both a start and end date.';
	const from = Date.parse(`${filters.from}T00:00:00.000Z`);
	const to = Date.parse(`${filters.to}T00:00:00.000Z`);
	if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Choose valid UTC dates.';
	if (from > to) return 'The start date must not be after the end date.';
	if ((to - from) / DAY_MS + 1 > MAX_RANGE_DAYS) return 'Date ranges can include at most 30 days.';
	return null;
}

function normalized(filters: AuditLogFilters): AuditLogFilters {
	return {
		from: filters.from,
		to: filters.to,
		event: filters.event.trim(),
		actor: filters.actor.trim(),
		projectId: filters.projectId.trim(),
	};
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
	second: '2-digit',
});

function formatTimestamp(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function PrimitiveValue({ value }: { value: string | number | boolean | null }) {
	if (value === null) return <span className="text-muted-foreground">null</span>;
	if (typeof value === 'boolean') {
		return <span className="text-amber-700 dark:text-amber-300">{String(value)}</span>;
	}
	if (typeof value === 'number') {
		return <span className="text-violet-700 dark:text-violet-300">{value}</span>;
	}
	return <span className="break-all text-primary">{value || '""'}</span>;
}

function MetadataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
	if (Array.isArray(value)) {
		const items = value.map((item, index) => ({
			item,
			index,
			key: `${index}:${JSON.stringify(item)}`,
		}));
		return (
			<details open={depth === 0} className="group">
				<summary className="cursor-pointer select-none text-muted-foreground">
					Array({value.length})
				</summary>
				<div className="mt-1 border-l pl-3">
					{items.map(({ item, index, key }) => (
						<div key={key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 py-0.5">
							<span className="text-muted-foreground">{index}</span>
							<MetadataValue value={item} depth={depth + 1} />
						</div>
					))}
				</div>
			</details>
		);
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		return (
			<details open={depth === 0} className="group">
				<summary className="cursor-pointer select-none text-muted-foreground">
					Object({entries.length})
				</summary>
				<div className="mt-1 border-l pl-3">
					{entries.map(([key, item]) => (
						<div
							key={key}
							className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-2 py-0.5"
						>
							<span className="break-all text-muted-foreground">{key}</span>
							<MetadataValue value={item} depth={depth + 1} />
						</div>
					))}
				</div>
			</details>
		);
	}
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value === null
	) {
		return <PrimitiveValue value={value} />;
	}
	return <span className="break-all text-muted-foreground">Unsupported metadata value</span>;
}

function ActorLabel({
	id,
	users,
	loading,
}: {
	id: string;
	users: Record<string, ResolvedUser>;
	loading: boolean;
}) {
	return <UserLabel user={users[id]} fallbackId={id} loading={loading} />;
}

function EventList({
	events,
	selectedId,
	onSelect,
	users,
	usersLoading,
}: {
	events: AuditLogEntry[];
	selectedId: string | undefined;
	onSelect: (id: string) => void;
	users: Record<string, ResolvedUser>;
	usersLoading: boolean;
}) {
	return (
		<div className="min-w-[700px]">
			<div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b bg-muted/60 px-4 py-2 text-xs font-medium text-muted-foreground">
				<span>Event</span>
				<span>Actor</span>
				<span>Project</span>
				<span>Timestamp</span>
			</div>
			{events.map((event) => (
				<button
					key={event.id}
					type="button"
					aria-pressed={selectedId === event.id}
					onClick={() => onSelect(event.id)}
					className={cn(
						'grid w-full grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b px-4 py-3 text-left text-xs outline-none transition-colors last:border-b-0 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
						selectedId === event.id ? 'bg-primary/8' : 'bg-card',
					)}
				>
					<span className="truncate font-mono text-[12px] font-medium text-primary">
						{event.event}
					</span>
					<ActorLabel id={event.actor} users={users} loading={usersLoading} />
					<span className="truncate font-mono text-muted-foreground">
						{typeof event.metadata.project_id === 'string' ? event.metadata.project_id : '—'}
					</span>
					<time dateTime={event.ts} className="whitespace-nowrap text-muted-foreground">
						{formatTimestamp(event.ts)}
					</time>
				</button>
			))}
		</div>
	);
}

function EventDetails({
	event,
	users,
	usersLoading,
}: {
	event: AuditLogEntry;
	users: Record<string, ResolvedUser>;
	usersLoading: boolean;
}) {
	const { copied, copy } = useCopyToClipboard();
	return (
		<aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
			<div className="flex items-center justify-between border-b px-4 py-3">
				<h2 className="text-sm font-semibold">Event details</h2>
				<Button
					variant="ghost"
					size="sm"
					aria-label="Copy event JSON"
					onPress={() => void copy(JSON.stringify(event, null, 2))}
				>
					{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
					{copied ? 'Copied' : 'Copy JSON'}
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<dl className="overflow-hidden rounded-lg border text-xs">
					{[
						['Event', event.event],
						['Event ID', event.id],
						['Timestamp', formatTimestamp(event.ts)],
						['Schema version', String(event.schema_version)],
					].map(([label, value]) => (
						<div
							key={label}
							className="grid grid-cols-[7rem_minmax(0,1fr)] border-b last:border-b-0"
						>
							<dt className="bg-muted/50 px-3 py-2 text-muted-foreground">{label}</dt>
							<dd className="break-all px-3 py-2 font-mono">{value}</dd>
						</div>
					))}
					<div className="grid grid-cols-[7rem_minmax(0,1fr)] border-t">
						<dt className="bg-muted/50 px-3 py-2 text-muted-foreground">Actor</dt>
						<dd className="flex min-w-0 flex-col px-3 py-2">
							<ActorLabel id={event.actor} users={users} loading={usersLoading} />
							<span className="break-all font-mono text-[11px] text-muted-foreground">
								{event.actor}
							</span>
						</dd>
					</div>
				</dl>

				<div className="mt-5">
					<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Metadata
					</h3>
					<div className="rounded-lg border bg-muted/25 p-3 font-mono text-xs leading-5">
						{Object.keys(event.metadata).length > 0 ? (
							<MetadataValue value={event.metadata} />
						) : (
							<span className="text-muted-foreground">No metadata</span>
						)}
					</div>
				</div>
			</div>
		</aside>
	);
}

function LoadingRows() {
	return (
		<div className="flex flex-col gap-3 p-4" aria-label="Loading audit events">
			{Array.from({ length: 6 }, (_, index) => (
				<div key={index} className="flex items-center justify-between gap-4">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-32" />
				</div>
			))}
		</div>
	);
}

export default function AuditLogPage() {
	const initial = defaultFilters();
	const [draft, setDraft] = useState<AuditLogFilters>(initial);
	const [filters, setFilters] = useState<AuditLogFilters>(initial);
	const [selectedId, setSelectedId] = useState<string>();
	const validationError = rangeError(draft);
	const query = useAuditLogsQuery(filters);
	const events = query.data?.pages.flatMap((page) => page.items) ?? [];
	const selected = events.find((event) => event.id === selectedId) ?? events[0];
	const usersQuery = useUsersQuery(events.map((event) => event.actor));
	const users = usersQuery.data ?? {};

	const apply = (formEvent: SubmitEvent<HTMLFormElement>) => {
		formEvent.preventDefault();
		if (validationError) return;
		setSelectedId(undefined);
		setFilters(normalized(draft));
	};

	const clear = () => {
		const defaults = defaultFilters();
		setDraft(defaults);
		setFilters(defaults);
		setSelectedId(undefined);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6 max-md:overflow-y-auto max-md:p-3">
			<div className="mb-4 flex shrink-0 items-start justify-between gap-4 max-md:flex-col">
				<div>
					<h1 className="text-xl font-semibold">Audit logs</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Deployment-wide audit events for the selected UTC date range.
					</p>
				</div>
				<Button variant="default" size="sm" onPress={() => void query.refetch()}>
					<RefreshCw className={cn('size-3.5', query.isRefetching ? 'animate-spin' : '')} />
					Refresh
				</Button>
			</div>

			<form
				onSubmit={apply}
				className="mb-4 flex shrink-0 flex-wrap items-end gap-3 rounded-xl border bg-card p-3 shadow-xs"
			>
				<TextField
					type="date"
					label="From (UTC)"
					value={draft.from}
					onChange={(from) => setDraft((current) => ({ ...current, from }))}
					className="w-40"
				/>
				<TextField
					type="date"
					label="To (UTC)"
					value={draft.to}
					onChange={(to) => setDraft((current) => ({ ...current, to }))}
					className="w-40"
				/>
				<TextField
					label="Event type"
					placeholder="project.update"
					value={draft.event}
					onChange={(event) => setDraft((current) => ({ ...current, event }))}
					className="min-w-44 flex-1"
				/>
				<TextField
					label="Actor ID"
					placeholder="user_…"
					value={draft.actor}
					onChange={(actor) => setDraft((current) => ({ ...current, actor }))}
					className="min-w-44 flex-1"
				/>
				<TextField
					label="Project ID"
					placeholder="proj-…"
					value={draft.projectId}
					onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
					className="min-w-44 flex-1"
				/>
				<div className="flex gap-2">
					<Button type="submit" variant="primary" size="md" isDisabled={Boolean(validationError)}>
						Apply
					</Button>
					<Button type="button" variant="ghost" size="md" onPress={clear}>
						<FilterX className="size-3.5" />
						Clear
					</Button>
				</div>
				{validationError ? (
					<p className="w-full text-xs text-destructive">{validationError}</p>
				) : null}
			</form>

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.7fr)_minmax(22rem,0.8fr)] gap-4 max-lg:grid-cols-1 max-lg:overflow-y-auto">
				<section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
					<div className="min-h-0 flex-1 overflow-auto">
						{query.isPending ? (
							<LoadingRows />
						) : query.isError ? (
							<div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
								<p className="text-sm font-medium">Unable to load audit events</p>
								<p className="text-xs text-muted-foreground">{query.error.message}</p>
								<Button size="sm" onPress={() => void query.refetch()}>
									Retry
								</Button>
							</div>
						) : events.length === 0 ? (
							<div className="p-4">
								<EmptyState
									icon={<ScrollText />}
									message="No audit events found"
									description="Try a different date range or clear the filters."
								/>
							</div>
						) : (
							<EventList
								events={events}
								selectedId={selected?.id}
								onSelect={setSelectedId}
								users={users}
								usersLoading={usersQuery.isPending}
							/>
						)}
					</div>
					{query.hasNextPage ? (
						<div className="flex shrink-0 justify-center border-t p-3">
							<Button
								size="sm"
								isDisabled={query.isFetchingNextPage}
								onPress={() => void query.fetchNextPage()}
							>
								{query.isFetchingNextPage ? 'Loading…' : 'Load more'}
							</Button>
						</div>
					) : null}
				</section>

				{selected ? (
					<EventDetails event={selected} users={users} usersLoading={usersQuery.isPending} />
				) : (
					<aside className="flex min-h-64 items-center justify-center rounded-xl border border-dashed bg-card/50 p-8 text-sm text-muted-foreground">
						Select an event to inspect its metadata.
					</aside>
				)}
			</div>
		</div>
	);
}
