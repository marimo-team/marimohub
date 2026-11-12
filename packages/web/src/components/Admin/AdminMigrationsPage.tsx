import { toast } from 'sonner';
import { useAdminMigrationsQuery, useRequestMigrationAttempt } from '@/api/hooks';
import { Button, Chip, PageContainer, PageHeader } from '@/components/ui';
import { formatAbsolute } from '@/lib/time';
import type { MigrationDashboard } from '@/types';

type Row = MigrationDashboard['rows'][number];
const labels: Record<Row['status'], string> = {
	waiting: 'Waiting',
	initializing: 'Waiting for initialization',
	dependency: 'Waiting for prerequisite',
	running: 'Running',
	resuming: 'Waiting to resume',
	retrying: 'Retrying',
	blocked: 'Blocked',
	unavailable: 'Status unavailable',
	completed: 'Completed',
	not_recorded: 'Not recorded',
};
const time = (value?: string) => (value ? formatAbsolute(value) : 'Unavailable');

function MigrationTable({ rows }: { rows: Row[] }) {
	return (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full text-left text-sm max-md:block">
				<thead className="max-md:hidden">
					<tr className="border-b bg-muted/40">
						<th className="p-3">Migration</th>
						<th className="p-3">Status</th>
						<th className="p-3">Saved progress</th>
						<th className="p-3">Last progress</th>
					</tr>
				</thead>
				<tbody className="max-md:block">
					{rows.map((row) => (
						<tr key={row.id} className="border-b last:border-0 max-md:block max-md:py-2">
							<td aria-label={row.title} className="p-3 align-top max-md:block">
								<details>
									<summary className="cursor-pointer font-medium">{row.title}</summary>
									<div className="mt-3 space-y-2 break-words text-muted-foreground">
										<p>{row.description}</p>
										<p>{row.impact}</p>
										<p>ID: {row.id}</p>
										<p>Recorded attempts: {row.attempts ?? 'Unavailable'}</p>
										<p>First start: {time(row.started_at)}</p>
										<p>Last attempt: {time(row.last_attempt_at)}</p>
										{row.completed_at && <p>Completed: {time(row.completed_at)}</p>}
										{row.dependencies.length > 0 && (
											<p>Waiting for: {row.dependencies.join(', ')}</p>
										)}
										{row.failure && (
											<p>
												{row.failure.message} ({time(row.failure.at)})
											</p>
										)}
										{row.status === 'blocked' && (
											<p>
												The checkpoint is invalid or unsupported. Check server logs before repair.
											</p>
										)}
									</div>
								</details>
							</td>
							<td className="p-3 align-top max-md:block max-md:py-1">
								<Chip>{labels[row.status]}</Chip>
							</td>
							<td className="p-3 align-top max-md:block max-md:py-1">
								<span className="md:hidden">Saved progress: </span>
								{row.progress
									? `${row.progress.processed} ${row.progress_unit ?? 'items'} visited${row.progress.partial ? ' since tracking began' : ''}`
									: 'Unavailable'}
							</td>
							<td className="p-3 align-top max-md:block max-md:py-1">
								<span className="md:hidden">Last progress: </span>
								{time(row.last_progress_at)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export default function AdminMigrationsPage() {
	const query = useAdminMigrationsQuery();
	const attempt = useRequestMigrationAttempt();
	const data = query.data;
	const requestAttempt = () =>
		attempt.mutate(undefined, {
			onSuccess: (result) =>
				toast.success(
					result.status === 'already_complete'
						? 'Migrations are already complete.'
						: 'Attempt requested. Automatic continuation requires the host scheduler.',
				),
			onError: () => {
				toast.error('Could not request an attempt. Refresh status and try again.');
				void query.refetch();
			},
		});
	return (
		<PageContainer width="wide">
			<PageHeader
				actions={
					<div className="flex flex-wrap gap-2">
						<Button
							variant="default"
							onClick={() => void query.refetch()}
							isDisabled={query.isFetching}
						>
							Refresh
						</Button>
						<Button
							onClick={requestAttempt}
							isDisabled={!data?.actions_available || data.action !== 'ready' || attempt.isPending}
						>
							Request attempt
						</Button>
					</div>
				}
			>
				<h1 className="text-xl font-semibold">Migrations</h1>
			</PageHeader>
			<p className="mb-4 text-sm text-muted-foreground">
				Migrations run automatically. Requests preserve dependencies, active leases, and retry
				backoff. Worker deployments require the configured cron for automatic continuation.
			</p>
			{query.isPending && <output>Loading migration status…</output>}
			{query.isError && (
				<p role="alert">
					Could not load migrations. Session authentication and super-admin access are required.
					Refresh to try again.
				</p>
			)}
			{data && (
				<div className="space-y-4">
					{data.incomplete && (
						<p role="alert">Some statuses are unavailable. Counts are incomplete.</p>
					)}
					{!data.actions_available && <p>Manual attempts are unavailable on this host.</p>}
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						{Object.entries(data.counts).map(([key, count]) => (
							<div key={key} className="rounded-lg border p-3">
								<div className="text-2xl font-semibold">{count}</div>
								<div className="text-sm capitalize text-muted-foreground">
									{key.replaceAll('_', ' ')}
								</div>
							</div>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						Observed {time(data.observed_at)}. Missing telemetry is unavailable, not zero. Progress
						counts describe visits, not unique items.
					</p>
					{data.rows.length === 0 ? (
						<p>No migrations are registered.</p>
					) : (
						<>
							<MigrationTable rows={data.rows.filter((row) => !row.retired)} />
							{data.rows.some((row) => row.retired) && (
								<section className="space-y-3">
									<h2 className="font-semibold">Retired migrations</h2>
									<MigrationTable rows={data.rows.filter((row) => row.retired)} />
								</section>
							)}
						</>
					)}
				</div>
			)}
		</PageContainer>
	);
}
