import { lazy, Suspense, useState } from 'react';
import { toast } from 'sonner';
import { MoveRight } from 'lucide-react';
import {
	Button,
	ConfirmDialog,
	DialogModal,
	EmptyState,
	Skeleton,
	UserLabel,
} from '@/components/ui';
import {
	useNotebookVersionQuery,
	useNotebookVersionsQuery,
	useRestoreVersion,
	useUsersQuery,
} from '@/api/hooks';
import type { UserDirectory } from '@/api/hooks';
import { formatRelative } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { NotebookEntry, NotebookVersion } from '@/types';

// The diff pane is the only consumer of @pierre/diffs (shiki included), so it
// loads as its own chunk the first time the dialog renders a diff.
const VersionDiffView = lazy(() => import('./VersionDiffView'));

export interface VersionHistoryDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebook: NotebookEntry;
	/** Whether the viewer's project role allows restoring (the server also enforces). */
	canRestore: boolean;
}

const SELECT_CLASSES =
	'h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function optionLabel(v: NotebookVersion, isCurrent: boolean): string {
	const msg = v.message.length > 48 ? `${v.message.slice(0, 48)}…` : v.message;
	return `${formatRelative(v.saved_at)} · ${msg}${isCurrent ? ' (Current)' : ''}`;
}

interface VersionSelectProps {
	label: string;
	versions: NotebookVersion[];
	value: string;
	onChange: (versionId: string) => void;
}

function VersionSelect({ label, versions, value, onChange }: VersionSelectProps) {
	return (
		<select
			aria-label={label}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={SELECT_CLASSES}
		>
			{versions.map((v, i) => (
				<option key={v.version_id} value={v.version_id}>
					{optionLabel(v, i === 0)}
				</option>
			))}
		</select>
	);
}

interface VersionListItemProps {
	version: NotebookVersion;
	isCurrent: boolean;
	isBase: boolean;
	isCompare: boolean;
	users: UserDirectory | undefined;
	usersLoading: boolean;
	showRestore: boolean;
	onSelect: () => void;
	onRestore: () => void;
}

function VersionListItem({
	version,
	isCurrent,
	isBase,
	isCompare,
	users,
	usersLoading,
	showRestore,
	onSelect,
	onRestore,
}: VersionListItemProps) {
	return (
		<li data-testid="version-row" className="flex items-center gap-2">
			<button
				type="button"
				onClick={onSelect}
				className={cn(
					'min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60',
					'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
					(isBase || isCompare) && 'bg-muted',
				)}
			>
				<span className="flex items-center gap-1.5 text-xs">
					<span className="font-medium">{formatRelative(version.saved_at)}</span>
					{isCurrent && (
						<span className="rounded bg-primary/10 px-1 py-px text-[10px] font-semibold text-primary">
							Current
						</span>
					)}
				</span>
				<span className="block truncate text-xs text-muted-foreground" title={version.message}>
					{version.message}
				</span>
				<UserLabel
					user={users?.[version.author]}
					fallbackId={version.author}
					loading={usersLoading}
					className="max-w-full text-xs text-muted-foreground"
				/>
			</button>
			{showRestore && (
				<Button variant="ghost" size="sm" onPress={onRestore} className="shrink-0">
					Restore
				</Button>
			)}
		</li>
	);
}

/**
 * Version history for one notebook: a newest-first list of saves, a
 * base → compare picker (defaulting to previous → current), a side-by-side
 * diff of the notebook file, and a confirmed per-version restore. Restore cuts
 * a NEW version from the old code — history is immutable, nothing is lost.
 */
export function VersionHistoryDialog({
	isOpen,
	onClose,
	projectId,
	notebook,
	canRestore,
}: VersionHistoryDialogProps) {
	// null = derived default (previous / current); explicit picks are validated
	// against the fetched list so selection self-heals when it refetches.
	const [baseId, setBaseId] = useState<string | null>(null);
	const [compareId, setCompareId] = useState<string | null>(null);
	const [restoreTarget, setRestoreTarget] = useState<NotebookVersion | null>(null);

	const versionsQuery = useNotebookVersionsQuery(projectId, notebook.id);
	const versions = versionsQuery.data ?? [];
	const ids = new Set(versions.map((v) => v.version_id));

	const effectiveCompare =
		compareId && ids.has(compareId) ? compareId : (versions[0]?.version_id ?? null);
	const effectiveBase =
		baseId && ids.has(baseId)
			? baseId
			: (versions[1]?.version_id ?? versions[0]?.version_id ?? null);

	const baseQuery = useNotebookVersionQuery(projectId, notebook.id, effectiveBase);
	const compareQuery = useNotebookVersionQuery(projectId, notebook.id, effectiveCompare);

	const { data: users, isLoading: usersLoading } = useUsersQuery(versions.map((v) => v.author));

	const restoreVersion = useRestoreVersion(projectId, notebook.id);
	// Git-synced content is owned by the sync; the API rejects restoring it.
	const restorable = canRestore && notebook.source_type !== 'git';

	const handleRestore = () => {
		if (!restoreTarget) return;
		restoreVersion.mutate(restoreTarget.version_id, {
			onSuccess: () => {
				toast.success('Version restored');
				setRestoreTarget(null);
				// Back to defaults: after the list refetches, the diff shows
				// what changed — pre-restore current → restored current.
				setBaseId(null);
				setCompareId(null);
			},
			onError: (err) => toast.error(err.message),
		});
	};

	const restoreTargetAuthor = restoreTarget
		? users?.[restoreTarget.author]?.name ||
			users?.[restoreTarget.author]?.email ||
			restoreTarget.author
		: '';

	const diffPane = () => {
		if (versions.length === 1) {
			return (
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					No previous versions to compare.
				</div>
			);
		}
		if (baseQuery.isError || compareQuery.isError) {
			return (
				<div className="flex h-full items-center justify-center text-sm text-destructive">
					Failed to load version code.
				</div>
			);
		}
		if (!baseQuery.data || !compareQuery.data) {
			return <Skeleton className="h-full w-full" />;
		}
		return (
			<Suspense fallback={<Skeleton className="h-full w-full" />}>
				<VersionDiffView
					fileName="notebook.py"
					oldCode={baseQuery.data.code}
					newCode={compareQuery.data.code}
				/>
			</Suspense>
		);
	};

	return (
		<>
			<DialogModal
				isOpen={isOpen}
				onClose={onClose}
				title={`Version history — ${notebook.title}`}
				width="xl"
			>
				{versionsQuery.isLoading ? (
					<div className="flex h-[70vh] flex-col gap-2">
						<Skeleton className="h-8 w-1/3" />
						<Skeleton className="h-full w-full" />
					</div>
				) : versionsQuery.isError ? (
					<EmptyState
						message="Failed to load version history."
						action={
							<Button variant="ghost" onPress={() => void versionsQuery.refetch()}>
								Retry
							</Button>
						}
					/>
				) : versions.length === 0 ? (
					<EmptyState message="No versions yet" />
				) : (
					// minmax(0,1fr): a long version message in a <select> option must not
					// widen the column past the dialog (grid min-width defaults to auto).
					<div className="grid h-[70vh] grid-cols-[280px_minmax(0,1fr)] gap-4">
						<aside className="min-h-0 overflow-y-auto border-r pr-3">
							<ul className="flex flex-col gap-1">
								{versions.map((v, i) => (
									<VersionListItem
										key={v.version_id}
										version={v}
										isCurrent={i === 0}
										isBase={v.version_id === effectiveBase}
										isCompare={v.version_id === effectiveCompare}
										users={users}
										usersLoading={usersLoading}
										showRestore={restorable && i !== 0}
										onSelect={() => {
											setBaseId(v.version_id);
											setCompareId(null);
										}}
										onRestore={() => setRestoreTarget(v)}
									/>
								))}
							</ul>
						</aside>
						<section className="flex min-h-0 flex-col gap-3">
							<div className="flex items-center gap-2">
								<VersionSelect
									label="Base version"
									versions={versions}
									value={effectiveBase ?? ''}
									onChange={setBaseId}
								/>
								<MoveRight className="size-4 shrink-0 text-muted-foreground" />
								<VersionSelect
									label="Compare version"
									versions={versions}
									value={effectiveCompare ?? ''}
									onChange={setCompareId}
								/>
							</div>
							<div className="min-h-0 flex-1">{diffPane()}</div>
						</section>
					</div>
				)}
			</DialogModal>

			<ConfirmDialog
				isOpen={!!restoreTarget}
				onClose={() => setRestoreTarget(null)}
				title="Restore Version"
				description={
					restoreTarget
						? `Restore the version saved ${formatRelative(restoreTarget.saved_at)} by ${restoreTargetAuthor}? Your current notebook is preserved as a version in history — nothing is lost.`
						: ''
				}
				confirmLabel="Restore"
				pendingLabel="Restoring..."
				isPending={restoreVersion.isPending}
				variant="primary"
				onConfirm={handleRestore}
			/>
		</>
	);
}
