import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
	useCancelJobRun,
	useCapabilitiesQuery,
	useDeleteJob,
	useJobRunQuery,
	useJobRunsQuery,
	useJobsQuery,
	useNotebookQuery,
	useProjectQuery,
	useTriggerJobRun,
	useUpdateJob,
} from '@/api/hooks';
import { Button, Chip, ConfirmDialog, EmptyState, IconLink, Skeleton } from '@/components/ui';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useDisclosure } from '@/hooks/useDisclosure';
import { toastError } from '@/lib/errors';
import { describeSchedule } from '@/lib/jobs';
import { formatElapsed } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Job, JobRun } from '@/types';
import { JobFormDialog } from './JobFormDialog';
import { RunDetail } from './RunDetail';
import { RunTable } from './RunTable';

function useJobsPageModel() {
	const { pid, nid } = useParams<{ pid: string; nid: string }>();
	const projectId = pid!;
	const notebookId = nid!;
	const location = useLocation();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: project } = useProjectQuery(projectId);
	const { data: notebook } = useNotebookQuery(projectId, notebookId);
	const title =
		notebook?.meta.title ?? (location.state as { title?: string } | null)?.title ?? notebookId;
	const canEdit = project.your_role !== 'viewer';
	const { data: capabilities, isError: capabilitiesError } = useCapabilitiesQuery();
	// Unknown until the probe answers (the list waits, so an off deployment is
	// never asked); a failed probe assumes on rather than hiding a live feature.
	const jobsAvailable = capabilities
		? (capabilities.jobs?.available ?? false)
		: capabilitiesError
			? true
			: undefined;

	const jobs = useJobsQuery(projectId, notebookId, jobsAvailable === true);
	// A stale `?job=` (deleted, or from someone else's link) falls back to the first job.
	const requestedJobId = searchParams.get('job');
	const selectedJob = jobs.data?.find((job) => job.id === requestedJobId) ?? jobs.data?.[0] ?? null;
	const selectedJobId = selectedJob?.id ?? null;
	const runs = useJobRunsQuery(projectId, notebookId, selectedJob?.id ?? null);
	const selectedRunId = searchParams.get('run');
	const pagedRun = runs.data?.find((run) => run.run_id === selectedRunId) ?? null;
	const selectedRunQuery = useJobRunQuery(
		projectId,
		notebookId,
		selectedJobId,
		selectedRunId,
		!!selectedRunId && !runs.isPending && !pagedRun,
	);
	const selectedRun = pagedRun ?? selectedRunQuery.data ?? null;

	const select = (next: { job?: string | null; run?: string | null }) => {
		setSearchParams(
			(current) => {
				const params = new URLSearchParams(current);
				if (next.job !== undefined) {
					if (next.job) params.set('job', next.job);
					else params.delete('job');
					params.delete('run');
				}
				if (next.run !== undefined) {
					if (next.run) params.set('run', next.run);
					else params.delete('run');
				}
				return params;
			},
			{ replace: true },
		);
	};

	const createDialog = useDisclosure();
	const editDialog = useDialogTarget<Job>();
	const deleteDialog = useDialogTarget<Job>();
	const cancelDialog = useDialogTarget<JobRun>();
	const update = useUpdateJob(projectId, notebookId);
	const remove = useDeleteJob(projectId, notebookId);
	const trigger = useTriggerJobRun(projectId, notebookId);
	const cancel = useCancelJobRun(projectId, notebookId);

	const runNow = async (job: Job) => {
		try {
			const run = await trigger.mutateAsync({ jobId: job.id });
			toast.success('Run queued');
			select({ job: job.id, run: run.run_id });
		} catch (err) {
			toastError(err);
		}
	};
	const toggleEnabled = async (job: Job) => {
		try {
			await update.mutateAsync({ jobId: job.id, updatedAt: job.updated_at, enabled: !job.enabled });
		} catch (err) {
			toastError(err);
		}
	};
	const confirmDelete = async () => {
		const job = deleteDialog.target;
		if (!job) return;
		try {
			await remove.mutateAsync({ jobId: job.id, updatedAt: job.updated_at });
			deleteDialog.close();
			if (selectedJobId === job.id) select({ job: null });
			toast.success('Job deleted');
		} catch (err) {
			toastError(err);
		}
	};
	const confirmCancel = async () => {
		const run = cancelDialog.target;
		if (!run) return;
		try {
			await cancel.mutateAsync({ jobId: run.job_id, runId: run.run_id });
			cancelDialog.close();
		} catch (err) {
			toastError(err);
		}
	};

	return {
		jobsAvailable,
		projectId,
		notebookId,
		title,
		canEdit,
		jobs,
		selectedJob,
		runs,
		selectedRun,
		select,
		createDialog,
		editDialog,
		deleteDialog,
		cancelDialog,
		runNow,
		toggleEnabled,
		confirmDelete,
		confirmCancel,
		triggerPending: trigger.isPending,
		removePending: remove.isPending,
		cancelPending: cancel.isPending,
		backToProject: () => void navigate(`/projects/${projectId}`),
	};
}

/**
 * A notebook's jobs: definitions on the left, the selected job's run history
 * and a selected run's captured output on the right. Full-screen like the
 * editor and snapshot pages; never starts a session.
 */
export function JobsPage() {
	const m = useJobsPageModel();
	const { selectedJob, selectedRun } = m;

	return (
		<div className="flex h-dvh flex-col">
			<title>{`${m.title} · Jobs · marimohub`}</title>
			<header className="flex h-10 min-h-10 items-center gap-2 border-b bg-background px-3 max-md:h-11 max-md:min-h-11">
				<IconLink
					to={`/projects/${m.projectId}`}
					label="Back to project"
					variant="bordered"
					className="max-md:size-11"
				>
					<ArrowLeft className="size-4" />
				</IconLink>
				<div className="h-5 w-px bg-border" />
				<span className="truncate text-[13px] font-medium">{m.title}</span>
				<Chip>
					<CalendarClock className="size-3" />
					Jobs
				</Chip>
				<div className="ml-auto flex items-center gap-2">
					{m.canEdit && m.jobsAvailable !== false && (
						<Button variant="primary" size="sm" onPress={m.createDialog.open}>
							<Plus className="size-4" />
							New job
						</Button>
					)}
				</div>
			</header>

			{m.jobsAvailable === false ? (
				<EmptyState
					icon={<CalendarClock className="size-6" />}
					message="Notebook jobs are off on this deployment"
					description="An operator can turn them on with MARIMOHUB_JOBS=on."
				/>
			) : (
				<div className="flex min-h-0 flex-1 max-md:flex-col">
					<aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r max-md:w-full max-md:max-h-56 max-md:border-r-0 max-md:border-b">
						{m.jobs.isPending ? (
							<div className="flex flex-col gap-2 p-3">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</div>
						) : m.jobs.isError ? (
							<p className="p-3 text-xs text-destructive">Failed to load jobs.</p>
						) : m.jobs.data.length === 0 ? (
							<EmptyState
								icon={<CalendarClock className="size-6" />}
								message="No jobs yet"
								description={
									m.canEdit
										? 'Create a job to run this notebook on a schedule or on demand.'
										: 'Editors can schedule this notebook to run headlessly.'
								}
							/>
						) : (
							<ul className="flex flex-col p-2">
								{m.jobs.data.map((job) => (
									<li key={job.id}>
										<button
											type="button"
											data-testid="job-row"
											aria-pressed={job.id === selectedJob?.id}
											onClick={() => m.select({ job: job.id })}
											className={cn(
												'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/60',
												'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
												job.id === selectedJob?.id && 'bg-muted',
											)}
										>
											<span className="flex items-center gap-2 text-sm">
												<span className="truncate font-medium">{job.name}</span>
												{!job.enabled && (
													<span className="rounded bg-muted px-1 py-px text-[10px] font-semibold text-muted-foreground">
														Disabled
													</span>
												)}
											</span>
											<span className="truncate text-xs text-muted-foreground">
												{describeSchedule(job)}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</aside>

					<main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
						{selectedJob ? (
							<>
								<div className="flex flex-wrap items-start gap-3">
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<h1 className="truncate text-base font-semibold">{selectedJob.name}</h1>
										<p className="text-xs text-muted-foreground">
											{describeSchedule(selectedJob)}
											{selectedJob.timeout_seconds !== undefined &&
												` · timeout ${formatElapsed(selectedJob.timeout_seconds * 1000)}`}
											{selectedJob.retry &&
												selectedJob.retry.max_retries > 0 &&
												` · ${selectedJob.retry.max_retries} retries`}
										</p>
									</div>
									{m.canEdit && (
										<div className="flex flex-wrap items-center gap-1.5">
											<Button
												variant="primary"
												size="sm"
												isDisabled={m.triggerPending}
												onPress={() => void m.runNow(selectedJob)}
											>
												<Play className="size-3.5" />
												Run now
											</Button>
											<Button
												variant="default"
												size="sm"
												onPress={() => void m.toggleEnabled(selectedJob)}
											>
												{selectedJob.enabled ? 'Disable' : 'Enable'}
											</Button>
											<Button
												variant="default"
												size="sm"
												onPress={() => m.editDialog.open(selectedJob)}
											>
												<Pencil className="size-3.5" />
												Edit
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onPress={() => m.deleteDialog.open(selectedJob)}
											>
												<Trash2 className="size-3.5" />
												Delete
											</Button>
										</div>
									)}
								</div>

								<section aria-label="Run history" className="flex flex-col gap-2">
									<h2 className="text-xs font-medium text-muted-foreground">Runs</h2>
									{m.runs.isPending ? (
										<Skeleton className="h-16 w-full" />
									) : m.runs.isError ? (
										<p className="text-xs text-destructive">Failed to load runs.</p>
									) : (
										<RunTable
											runs={m.runs.data}
											selectedRunId={selectedRun?.run_id ?? null}
											onSelect={(run) => m.select({ job: selectedJob.id, run: run.run_id })}
										/>
									)}
									{m.runs.hasNextPage && (
										<Button
											variant="default"
											size="sm"
											isDisabled={m.runs.isFetchingNextPage}
											onPress={() => void m.runs.fetchNextPage()}
										>
											{m.runs.isFetchingNextPage ? 'Loading…' : 'Load more runs'}
										</Button>
									)}
								</section>

								{selectedRun && (
									<RunDetail
										projectId={m.projectId}
										notebookId={m.notebookId}
										job={selectedJob}
										run={selectedRun}
										canEdit={m.canEdit}
										onCancel={m.cancelDialog.open}
									/>
								)}
							</>
						) : (
							!m.jobs.isPending && (
								<p className="text-sm text-muted-foreground">Select a job to see its runs.</p>
							)
						)}
					</main>
				</div>
			)}

			<JobFormDialog
				isOpen={m.createDialog.isOpen}
				onClose={m.createDialog.close}
				projectId={m.projectId}
				notebookId={m.notebookId}
				onSaved={(job) => m.select({ job: job.id })}
			/>
			{m.editDialog.target && (
				<JobFormDialog
					isOpen
					onClose={m.editDialog.close}
					projectId={m.projectId}
					notebookId={m.notebookId}
					job={m.editDialog.target}
				/>
			)}
			<ConfirmDialog
				isOpen={m.deleteDialog.isOpen}
				onClose={m.deleteDialog.close}
				title="Delete job"
				description={`Delete "${m.deleteDialog.target?.name ?? ''}" and its run history? Active runs are cancelled.`}
				confirmLabel="Delete"
				pendingLabel="Deleting…"
				isPending={m.removePending}
				onConfirm={() => void m.confirmDelete()}
			/>
			<ConfirmDialog
				isOpen={m.cancelDialog.isOpen}
				onClose={m.cancelDialog.close}
				title="Cancel run"
				description="Stop this run and destroy its sandbox? Any output captured before cancellation remains available."
				confirmLabel="Cancel run"
				pendingLabel="Cancelling…"
				isPending={m.cancelPending}
				onConfirm={() => void m.confirmCancel()}
			/>
		</div>
	);
}
