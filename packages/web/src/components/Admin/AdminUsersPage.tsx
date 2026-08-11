import { Ban, SearchX, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
	Button,
	Chip,
	ConfirmDialog,
	EmptyState,
	PageContainer,
	PageHeader,
	SearchField,
} from '@/components/ui';
import { useAdminUsersQuery, useSetUserSuspension } from '@/api/hooks';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useSearchField } from '@/hooks/useSearchField';
import { filterBySearch } from '@/lib/search';
import type { AdminUser } from '@/types';

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
});

function formatTimestamp(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

const ROW_GRID = 'grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto]';

export default function AdminUsersPage() {
	const search = useSearchField();
	const { data: users } = useAdminUsersQuery();
	const setSuspension = useSetUserSuspension();
	const suspensionDialog = useDialogTarget<AdminUser>();
	// Trimmed so a whitespace-only query counts as no search (filterBySearch
	// semantics) — an empty directory then shows its own empty state.
	const query = search.query.trim();
	const filtered = filterBySearch(users, query, (u) => `${u.name} ${u.email} ${u.id}`);
	const target = suspensionDialog.target;
	const suspending = target?.suspended_at == null;

	const confirmSuspension = () => {
		if (!target) return;
		setSuspension.mutate(
			{ userId: target.id, suspended: suspending },
			{
				onSuccess: () => {
					toast.success(suspending ? `${target.name} suspended` : `${target.name} reactivated`);
					suspensionDialog.close();
				},
			},
		);
	};

	return (
		<PageContainer>
			<title>Users · marimohub</title>
			<PageHeader>
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="text-2xl font-semibold tracking-tight">Users</h1>
					<p className="text-sm text-muted-foreground">
						{users.length} user{users.length !== 1 ? 's' : ''} · everyone who has signed in at least
						once
					</p>
				</div>
			</PageHeader>

			<div className="mb-4">
				<SearchField
					aria-label="Search users"
					placeholder="Search users..."
					value={search.query}
					onChange={search.setQuery}
					inputRef={search.inputRef}
				/>
			</div>

			{filtered.length === 0 ? (
				query ? (
					<EmptyState
						icon={<SearchX />}
						message={`No users matching "${query}"`}
						description="Try a different search term."
					/>
				) : (
					<EmptyState
						icon={<Users />}
						message="No users yet"
						description="Users appear here after their first sign-in."
					/>
				)
			) : (
				<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
					<div
						className={`grid ${ROW_GRID} gap-3 border-b bg-muted/60 px-4 py-2 text-xs font-medium text-muted-foreground`}
					>
						<span>User</span>
						<span>User id</span>
						<span
							className="text-right"
							title="Approximate — when this user's identity record was last refreshed"
						>
							Last active
						</span>
						<span className="sr-only">Actions</span>
					</div>
					{filtered.map((user) => (
						<div
							key={user.id}
							data-testid="admin-user-row"
							className={`grid ${ROW_GRID} items-center gap-3 border-b px-4 py-3 last:border-b-0`}
						>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="flex min-w-0 items-center gap-2">
									<span className="truncate text-sm font-medium">{user.name}</span>
									{user.is_super_admin && (
										<Chip>
											<ShieldCheck className="size-3" />
											Super admin
										</Chip>
									)}
									{user.suspended_at && (
										<Chip>
											<Ban className="size-3" />
											Suspended
										</Chip>
									)}
								</span>
								<span className="truncate text-xs text-muted-foreground">{user.email}</span>
							</span>
							<span className="truncate font-mono text-xs text-muted-foreground">{user.id}</span>
							<span className="text-right text-xs tabular-nums text-muted-foreground">
								{formatTimestamp(user.updated_at)}
							</span>
							<Button
								size="sm"
								variant={user.suspended_at ? 'default' : 'danger'}
								onPress={() => suspensionDialog.open(user)}
							>
								{user.suspended_at ? (
									<UserCheck className="size-3.5" />
								) : (
									<Ban className="size-3.5" />
								)}
								{user.suspended_at ? 'Reactivate' : 'Suspend'}
							</Button>
						</div>
					))}
				</div>
			)}

			<ConfirmDialog
				isOpen={suspensionDialog.isOpen}
				onClose={suspensionDialog.close}
				title={`${suspending ? 'Suspend' : 'Reactivate'} ${target?.name ?? 'user'}`}
				description={
					suspending
						? 'This user will be blocked from signing in or using personal access tokens. Running sandbox sessions are not terminated.'
						: 'This user will be able to sign in and use their personal access tokens again.'
				}
				confirmLabel={suspending ? 'Suspend' : 'Reactivate'}
				pendingLabel={suspending ? 'Suspending…' : 'Reactivating…'}
				variant={suspending ? 'danger' : 'primary'}
				isPending={setSuspension.isPending}
				onConfirm={confirmSuspension}
			/>
		</PageContainer>
	);
}
