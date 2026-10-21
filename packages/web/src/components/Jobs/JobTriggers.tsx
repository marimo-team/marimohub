import { useState } from 'react';
import { useChainNotebooksQuery, useJobsQuery } from '@/api/hooks';
import { Button, CopyField } from '@/components/ui';
import { withBasePath } from '@/lib/basePath';
import type { Job } from '@/types';

type Chain = NonNullable<Job['chain']>;
const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-sm';

function ChainTargetName({
	projectId,
	target,
}: {
	projectId: string;
	target: NonNullable<Chain['on_success']>[number];
}) {
	const jobs = useJobsQuery(projectId, target.notebook_id);
	return jobs.data?.find((job) => job.id === target.job_id)?.name ?? target.job_id;
}

export function ChainPicker({
	projectId,
	notebookId,
	jobId,
	value,
	onChange,
}: {
	projectId: string;
	notebookId: string;
	jobId?: string;
	value: Chain;
	onChange: (chain: Chain) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [targetNotebook, setTargetNotebook] = useState(notebookId);
	const notebooks = useChainNotebooksQuery(projectId, expanded);
	const jobs = useJobsQuery(projectId, targetNotebook, expanded);
	return (
		<fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
			<legend className="px-1 text-xs font-medium text-muted-foreground">Chaining</legend>
			<p className="text-xs text-muted-foreground">
				Run up to five jobs after success or after the last failed attempt. Chains stop after eight
				steps.
			</p>
			<Button variant="default" size="sm" onPress={() => setExpanded(!expanded)}>
				{expanded ? 'Hide job picker' : 'Choose downstream jobs'}
			</Button>
			{expanded && (
				<label className="flex flex-col gap-1 text-xs">
					Target notebook
					<select
						className={selectClass}
						value={targetNotebook}
						onChange={(e) => setTargetNotebook(e.target.value)}
					>
						<option value={notebookId}>This notebook</option>
						{notebooks.data
							?.filter((nb) => nb.id !== notebookId)
							.map((nb) => (
								<option key={nb.id} value={nb.id}>
									{nb.title}
								</option>
							))}
					</select>
				</label>
			)}
			{expanded && (notebooks.isError || jobs.isError) && (
				<p role="alert" className="text-xs text-destructive">
					Could not load chain targets. Reopen the picker to retry.
				</p>
			)}
			{(['on_success', 'on_failure'] as const).map((kind) => (
				<div key={kind} className="flex flex-col gap-2">
					{expanded && (
						<label className="flex flex-col gap-1 text-xs">
							{kind === 'on_success' ? 'After success' : 'After failure'}
							<select
								className={selectClass}
								value=""
								disabled={jobs.isPending || (value[kind]?.length ?? 0) >= 5}
								onChange={(e) => {
									const id = e.target.value;
									if (id)
										onChange({
											...value,
											[kind]: [...(value[kind] ?? []), { notebook_id: targetNotebook, job_id: id }],
										});
								}}
							>
								<option value="">{jobs.isPending ? 'Loading jobs…' : 'Add a job…'}</option>
								{jobs.data
									?.filter(
										(job) =>
											(targetNotebook !== notebookId || job.id !== jobId) &&
											!value[kind]?.some(
												(ref) => ref.job_id === job.id && ref.notebook_id === targetNotebook,
											),
									)
									.map((job) => (
										<option key={job.id} value={job.id}>
											{job.name}
											{job.enabled ? '' : ' (disabled)'}
										</option>
									))}
							</select>
						</label>
					)}
					{value[kind]?.map((ref) => (
						<div
							key={`${ref.notebook_id}:${ref.job_id}`}
							className="flex items-center justify-between gap-2 text-xs"
						>
							<span>
								{kind === 'on_success' ? 'Success' : 'Failure'}:{' '}
								<ChainTargetName projectId={projectId} target={ref} />
							</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Remove ${kind} target ${ref.job_id}`}
								onPress={() =>
									onChange({ ...value, [kind]: value[kind]?.filter((item) => item !== ref) })
								}
							>
								Remove
							</Button>
						</div>
					))}
				</div>
			))}
		</fieldset>
	);
}

export function WebhookTriggerPanel({
	projectId,
	notebookId,
	job,
}: {
	projectId: string;
	notebookId: string;
	job: Job;
}) {
	const path = withBasePath(
		`/api/v1/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(notebookId)}/jobs/${encodeURIComponent(job.id)}/trigger`,
	);
	const url = new URL(path, window.location.origin).href;
	return (
		<fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
			<legend className="px-1 text-xs font-medium text-muted-foreground">Webhook trigger</legend>
			<CopyField label="Trigger URL" value={url} />
			<p className="text-xs text-muted-foreground">
				Send a POST request with a personal access token as a Bearer credential. In API tokens,
				choose Trigger jobs and limit access to this project. Disable the job to stop webhook runs.
			</p>
		</fieldset>
	);
}
