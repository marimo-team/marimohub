import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { AppWindow, Pause, Play, RefreshCw, Server, Users, GitBranch } from 'lucide-react';
import { useAdminRuntimeQuery, useUsersQuery } from '@/api/hooks';
import {
	Button,
	Chip,
	CopyField,
	DialogModal,
	PageContainer,
	PageHeader,
	SearchField,
	UserLabel,
} from '@/components/ui';
import { useNow } from '@/hooks/useNow';
import { formatAbsolute, formatDuration, formatRelative } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { RuntimeDashboard } from '@/types';

type RuntimeApp = RuntimeDashboard['apps'][number];
type Sandbox = RuntimeApp['sandboxes'][number];
type Editor = RuntimeDashboard['editors'][number];

const versionLabels = {
	current: 'Current version',
	old: 'Old version',
	unknown: 'Unknown version',
};
const shortId = (id: string) => `…${id.slice(-8)}`;

function LocationLinks({
	item,
}: {
	item: Pick<RuntimeApp, 'project_id' | 'project_name' | 'notebook_id' | 'notebook_title'>;
}) {
	return (
		<div className="min-w-0">
			<Link
				className="break-words font-medium hover:underline"
				to={`/projects/${item.project_id}/notebooks/${item.notebook_id}`}
			>
				{item.notebook_title}
			</Link>
			<Link
				className="mt-0.5 block text-xs text-muted-foreground hover:underline"
				to={`/projects/${item.project_id}`}
			>
				{item.project_name}
			</Link>
		</div>
	);
}

function occupiedSlots(sandboxes: Sandbox[]): string {
	const total = sandboxes.reduce((sum, sandbox) => sum + (sandbox.users ?? 0), 0);
	return `${sandboxes.some((sandbox) => sandbox.users === null) ? '≥ ' : ''}${total}`;
}

function Connections({
	session,
}: {
	session: Pick<Editor, 'active_connections' | 'connections_checked_at'>;
}) {
	return (
		<>
			{session.active_connections === null ? 'Unknown' : `~${session.active_connections}`}
			<span className="block text-xs text-muted-foreground">
				Checked {formatAbsolute(session.connections_checked_at ?? undefined)}
			</span>
		</>
	);
}

function Occupancy({ users, limit }: { users: number | null; limit: number | null }) {
	const label =
		users === null
			? 'Occupancy unknown'
			: limit === null
				? `${users} occupied slots · unlimited capacity`
				: `${users} / ${limit} occupied slots`;
	return (
		<div className="space-y-2">
			<div className="text-sm font-medium tabular-nums">{label}</div>
			{users !== null &&
				limit !== null &&
				(limit <= 12 ? (
					<div className="flex gap-1" aria-hidden="true">
						{Array.from({ length: limit }, (_, i) => (
							<span
								key={i}
								className={cn('h-2 flex-1 rounded-sm', i < users ? 'bg-primary' : 'bg-muted')}
							/>
						))}
					</div>
				) : (
					<progress
						aria-label="Occupied slots"
						max={limit}
						value={Math.min(users, limit)}
						aria-valuetext={label}
						className="h-2 w-full overflow-hidden rounded-full border-0 bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
					/>
				))}
		</div>
	);
}

function AppCard({
	app,
	limits,
	now,
	onSelect,
}: {
	app: RuntimeApp;
	limits: RuntimeDashboard['limits'];
	now: number;
	onSelect: (id: string) => void;
}) {
	const groups = new Map<string, Sandbox[]>();
	for (const sandbox of app.sandboxes) {
		const key = sandbox.source_version_id ?? '';
		const group = groups.get(key) ?? [];
		group.push(sandbox);
		groups.set(key, group);
	}
	const versions = [...groups.entries()].sort(
		([a, aa], [b, bb]) =>
			Number(bb[0].version_status === 'current') - Number(aa[0].version_status === 'current') ||
			b.localeCompare(a),
	);
	return (
		<section
			className="rounded-xl border bg-card p-5 shadow-xs"
			aria-label={`${app.notebook_title} pool`}
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<LocationLinks item={app} />
				<div className="flex flex-wrap gap-2">
					<Chip>
						{app.sandboxes.length} {app.sandboxes.length === 1 ? 'sandbox' : 'sandboxes'}
					</Chip>
					<Chip>{occupiedSlots(app.sandboxes)} occupied slots</Chip>
					{app.incomplete && <Chip>Incomplete data</Chip>}
				</div>
			</div>
			<p className="mt-3 text-xs text-muted-foreground">
				Current-version pool: {app.current_version_members ?? 'Unknown'} /{' '}
				{limits.max_sessions_per_version ?? 'unlimited'} sandboxes ·{' '}
				{limits.max_users_per_session === null
					? 'Unlimited accounts per sandbox'
					: `${limits.max_users_per_session} accounts per sandbox`}
			</p>
			{app.current_version_id &&
				!app.sandboxes.some((sandbox) => sandbox.version_status === 'current') && (
					<p className="mt-3 text-sm text-muted-foreground">
						No sandbox for the current version ({shortId(app.current_version_id)}).
					</p>
				)}
			{versions.map(([version, sandboxes]) => (
				<div key={version} className="mt-5">
					<h3 className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium">
						<span
							className={cn(
								sandboxes[0].version_status === 'old' && 'text-amber-700 dark:text-amber-400',
							)}
						>
							{versionLabels[sandboxes[0].version_status]}
						</span>
						{version && (
							<code className="text-muted-foreground" title={version}>
								{shortId(version)}
							</code>
						)}
					</h3>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{sandboxes.map((sandbox) => (
							<Button
								key={sandbox.session_id}
								variant="unstyled"
								onPress={() => onSelect(sandbox.session_id)}
								aria-label={`Inspect sandbox ${sandbox.sandbox_id ?? sandbox.session_id}`}
								className="flex min-w-0 flex-col gap-3 rounded-lg border bg-background p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span className="flex w-full flex-wrap items-center justify-between gap-2">
									<span className="flex items-center gap-2 font-mono text-xs">
										<Server className="size-3.5" />
										{shortId(sandbox.sandbox_id ?? sandbox.session_id)}
									</span>
									<span className="text-xs capitalize">
										{sandbox.pool_state ?? sandbox.status ?? 'Unknown'}
									</span>
								</span>
								<div className="w-full">
									<Occupancy users={sandbox.users} limit={limits.max_users_per_session} />
								</div>
								<span className="text-xs text-muted-foreground">
									{sandbox.status === null && sandbox.pool_state === 'starting'
										? 'Reserved'
										: 'Started'}{' '}
									{formatRelative(sandbox.started_at, now)}
								</span>
								{sandbox.pool_state &&
									sandbox.status &&
									sandbox.status !== 'running' &&
									sandbox.status !== 'starting' && (
										<span className="text-xs capitalize">Session: {sandbox.status}</span>
									)}
								{sandbox.legacy && (
									<span className="text-xs text-muted-foreground">
										Legacy sandbox · occupancy unknown
									</span>
								)}
								{sandbox.incomplete && (
									<span className="text-xs text-amber-700 dark:text-amber-400">
										Incomplete session data
									</span>
								)}
							</Button>
						))}
					</div>
				</div>
			))}
		</section>
	);
}

function SandboxDetails({
	sandbox,
	now,
	observedAt,
}: {
	sandbox: Sandbox;
	now: number;
	observedAt: string;
}) {
	const { data: users, isError } = useUsersQuery([
		sandbox.user_id,
		...sandbox.assignments.map((assignment) => assignment.user_id),
	]);
	return (
		<div className="space-y-5">
			<div className="flex flex-wrap gap-2">
				<Chip>{versionLabels[sandbox.version_status]}</Chip>
				<Chip>{sandbox.pool_state ?? 'Unmanaged pool'}</Chip>
				{sandbox.incomplete && <Chip>Incomplete data</Chip>}
			</div>
			<CopyField label="Sandbox ID" value={sandbox.sandbox_id ?? 'Unknown'} />
			<CopyField label="Session ID" value={sandbox.session_id} />
			<CopyField label="Source version" value={sandbox.source_version_id ?? 'Unknown'} />
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
				<dt className="text-muted-foreground">Session status</dt>
				<dd>
					{sandbox.status ??
						(sandbox.pool_state === 'starting'
							? 'Reserved · session not yet recorded'
							: 'Session unavailable')}
				</dd>
				<dt className="text-muted-foreground">Started by</dt>
				<dd>
					<UserLabel user={users?.[sandbox.user_id]} fallbackId={sandbox.user_id} />
				</dd>
				<dt className="text-muted-foreground">Created</dt>
				<dd>
					{formatAbsolute(sandbox.started_at)} · {formatDuration(sandbox.started_at, now)} ago
				</dd>
				<dt className="text-muted-foreground">Last heartbeat</dt>
				<dd>{formatAbsolute(sandbox.last_heartbeat ?? undefined)}</dd>
				<dt className="text-muted-foreground">Idle for</dt>
				<dd>{sandbox.idle_since ? formatDuration(sandbox.idle_since, now) : '—'}</dd>
				<dt className="text-muted-foreground">Compute profile</dt>
				<dd>{sandbox.compute_profile ?? 'Not recorded'}</dd>
				<dt className="text-muted-foreground">Connections</dt>
				<dd>
					<Connections session={sandbox} />
				</dd>
			</dl>
			<div>
				<h3 className="mb-2 text-sm font-medium">
					Accounts · {sandbox.users ?? 'unknown occupancy'}
				</h3>
				<p className="mb-3 text-xs text-muted-foreground">
					Presence as of {formatAbsolute(observedAt)}. Multiple visits share one account slot;
					reconnect grace still occupies a slot.
				</p>
				{isError && (
					<p className="text-sm text-muted-foreground">Names unavailable; showing account IDs.</p>
				)}
				{sandbox.assignments.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{sandbox.users === null
							? 'Account occupancy is unavailable for this sandbox.'
							: 'No occupied account slots.'}
					</p>
				) : (
					<ul className="divide-y">
						{sandbox.assignments.map((assignment) => (
							<li
								key={assignment.user_id}
								className="flex flex-wrap justify-between gap-2 py-3 text-sm"
							>
								<div className="min-w-0">
									<UserLabel user={users?.[assignment.user_id]} fallbackId={assignment.user_id} />
									<p className="break-all text-xs text-muted-foreground">
										{users?.[assignment.user_id]?.email ?? assignment.user_id}
									</p>
								</div>
								<div className="text-right">
									<div>
										{assignment.state === 'active' ? 'Active visit' : 'Reconnect grace'} ·{' '}
										{assignment.visits} visits
									</div>
									<p className="text-xs text-muted-foreground">
										Expires {formatAbsolute(assignment.expires_at)}
									</p>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function EditorsTable({ editors, now }: { editors: Editor[]; now: number }) {
	const { data: users } = useUsersQuery(editors.map((editor) => editor.user_id));
	if (editors.length === 0)
		return (
			<p className="py-10 text-center text-sm text-muted-foreground">
				No editors match these filters.
			</p>
		);
	return (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full text-left text-sm">
				<caption className="px-4 py-3 text-left text-xs text-muted-foreground">
					Recorded editor sessions. Started by identifies the starter, not every connected editor.
				</caption>
				<thead className="border-y bg-muted/40 text-xs text-muted-foreground">
					<tr>
						{[
							'Notebook / project',
							'Started by',
							'Status / age',
							'Last heartbeat',
							'Connections',
							'Compute',
							'Initial source version',
						].map((label) => (
							<th key={label} className="whitespace-nowrap px-4 py-3 font-medium">
								{label}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y">
					{editors.map((editor) => (
						<tr key={editor.session_id}>
							<td className="min-w-48 px-4 py-3">
								<LocationLinks item={editor} />
								<code
									className="mt-1 block text-xs text-muted-foreground"
									title={editor.session_id}
								>
									{shortId(editor.session_id)}
								</code>
							</td>
							<td className="px-4 py-3">
								<UserLabel user={users?.[editor.user_id]} fallbackId={editor.user_id} />
							</td>
							<td className="px-4 py-3">
								<span className="capitalize">{editor.status}</span>
								<span className="block whitespace-nowrap text-xs text-muted-foreground">
									{formatDuration(editor.started_at, now)}
								</span>
							</td>
							<td className="px-4 py-3 text-xs">
								{formatAbsolute(editor.last_heartbeat ?? undefined)}
							</td>
							<td className="px-4 py-3">
								<Connections session={editor} />
							</td>
							<td className="px-4 py-3">{editor.compute_profile ?? 'Not recorded'}</td>
							<td className="px-4 py-3">
								<code className="text-xs" title={editor.source_version_id ?? undefined}>
									{editor.source_version_id ? shortId(editor.source_version_id) : 'Unknown'}
								</code>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export default function AdminRuntimePage() {
	const [paused, setPaused] = useState(false);
	const [project, setProject] = useState('');
	const [search, setSearch] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const { data, isError, isPending, isFetching, refetch } = useAdminRuntimeQuery(paused);
	const now = useNow(30_000);
	const projects = new Map(
		[...(data?.apps ?? []), ...(data?.editors ?? [])].map((item) => [
			item.project_id,
			item.project_name,
		]),
	);
	const query = search.trim().toLowerCase();
	const matches = (item: RuntimeApp | Editor) =>
		(!project || item.project_id === project) &&
		[
			item.project_name,
			item.notebook_title,
			item.project_id,
			item.notebook_id,
			...('sandboxes' in item
				? item.sandboxes.flatMap((sandbox) => [
						sandbox.session_id,
						sandbox.sandbox_id,
						sandbox.source_version_id,
					])
				: [item.session_id, item.sandbox_id, item.user_id, item.source_version_id]),
		].some((value) => value?.toLowerCase().includes(query));
	const apps = data?.apps.filter(matches) ?? [];
	const editors = data?.editors.filter(matches) ?? [];
	const sandboxes = apps.flatMap((app) => app.sandboxes);
	const selected = data?.apps
		.flatMap((app) => app.sandboxes)
		.find((sandbox) => sandbox.session_id === selectedId);
	const stats = [
		{ label: 'Active apps', value: apps.length, icon: AppWindow },
		{
			label: 'Running app sandboxes',
			value: sandboxes.filter((sandbox) => sandbox.status === 'running').length,
			icon: Server,
		},
		{
			label: 'Occupied account slots',
			value: occupiedSlots(sandboxes),
			icon: Users,
		},
		{
			label: 'Old-version sandboxes',
			value: sandboxes.filter((sandbox) => sandbox.version_status === 'old').length,
			icon: GitBranch,
		},
	];
	return (
		<PageContainer contentClassName="max-w-6xl">
			<PageHeader
				actions={
					<div className="flex gap-2">
						<Button onPress={() => setPaused((value) => !value)}>
							{paused ? <Play className="size-4" /> : <Pause className="size-4" />}
							{paused ? 'Resume' : 'Pause'}
						</Button>
						<Button isDisabled={isFetching} onPress={() => void refetch()}>
							<RefreshCw
								className={cn('size-4', isFetching && 'animate-spin motion-reduce:animate-none')}
							/>
							Refresh
						</Button>
					</div>
				}
			>
				<div>
					<h1 className="text-xl font-semibold">Runtime</h1>
					<p className="mt-1 text-sm text-muted-foreground">App pools and editor sessions</p>
				</div>
			</PageHeader>
			<div className="mb-5 flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
					Project
					<select
						className="h-10 max-w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground"
						value={project}
						onChange={(event) => setProject(event.target.value)}
					>
						<option value="">All projects</option>
						{project && !projects.has(project) && (
							<option value={project}>{project} (no active sessions)</option>
						)}
						{[...projects]
							.sort((a, b) => a[1].localeCompare(b[1]))
							.map(([id, name]) => (
								<option key={id} value={id}>
									{name}
								</option>
							))}
					</select>
				</label>
				<SearchField
					aria-label="Search runtime"
					placeholder="Search notebooks, versions, or IDs…"
					value={search}
					onChange={setSearch}
					className="min-w-0 flex-1 basis-60"
				/>
			</div>
			<p className="mb-4 text-xs text-muted-foreground">
				{data ? `Updated ${formatAbsolute(data.observed_at)}` : 'No snapshot yet'} ·{' '}
				{paused ? 'Auto-refresh paused' : 'Refreshes every 30 seconds while visible'}
			</p>
			{isError && (
				<p
					role="alert"
					className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
				>
					{data
						? 'Refresh failed. Showing the last successful snapshot.'
						: 'Could not load runtime data. Try Refresh.'}
				</p>
			)}
			{data?.incomplete && (
				<output className="mb-4 block rounded-lg border p-3 text-sm">
					Some runtime records are unavailable. Counts may be incomplete; unknown occupancy is not
					counted as zero.
				</output>
			)}
			{isPending && (
				<output className="block py-10 text-center text-muted-foreground">Loading runtime…</output>
			)}
			{data && (
				<Tabs defaultSelectedKey="apps">
					<TabList aria-label="Runtime views" className="mb-5 flex gap-1 border-b">
						{[
							['apps', 'Apps'],
							['editors', 'Editors'],
						].map(([id, label]) => (
							<Tab
								key={id}
								id={id}
								className="cursor-pointer border-b-2 border-transparent px-4 py-2 text-sm text-muted-foreground outline-none selected:border-primary selected:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							>
								{label}
							</Tab>
						))}
					</TabList>
					<TabPanel id="apps">
						<div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
							{stats.map(({ label, value, icon: Icon }) => (
								<div key={label} className="rounded-lg border bg-card p-4">
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										<Icon className="size-3.5 shrink-0" />
										{label}
									</div>
									<div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
								</div>
							))}
						</div>
						<p className="mb-4 text-xs text-muted-foreground">
							Account slots are counted per app, including reconnect grace. Old versions drain
							separately from the current-version limit. Project and starter-user limits also apply.
						</p>
						<div className="space-y-5">
							{apps.map((app) => (
								<AppCard
									key={`${app.project_id}/${app.notebook_id}`}
									app={app}
									limits={data.limits}
									now={now}
									onSelect={setSelectedId}
								/>
							))}
						</div>
						{apps.length === 0 && (
							<p className="py-10 text-center text-sm text-muted-foreground">
								No active apps match these filters.
							</p>
						)}
					</TabPanel>
					<TabPanel id="editors">
						<EditorsTable editors={editors} now={now} />
					</TabPanel>
				</Tabs>
			)}
			<p className="mt-6 text-xs text-muted-foreground">
				Recorded state, not a live compute health check. Connections are approximate and may include
				clients outside managed app visits.
			</p>
			<DialogModal
				isOpen={selectedId !== null}
				onClose={() => setSelectedId(null)}
				title="Sandbox details"
				width="lg"
			>
				{selected && data ? (
					<SandboxDetails sandbox={selected} now={now} observedAt={data.observed_at} />
				) : (
					<p className="text-sm text-muted-foreground">
						This sandbox is no longer in the runtime snapshot.
					</p>
				)}
			</DialogModal>
		</PageContainer>
	);
}
