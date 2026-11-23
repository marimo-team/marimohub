import type { UserId } from '../../ids';
import type { JobDefinition, JobRun, PublicJobRun } from '../../schema';
import { isTerminalRunStatus } from './runState';

export interface JobCapabilities {
	canTrigger: boolean;
	history: 'none' | 'summary' | 'full';
	canReadHtml: boolean;
	canReadLogs: boolean;
}

// Resource and credential authorization must precede these job-local decisions.
export function jobCapabilities({
	job,
	userId,
	editor,
	triggerAllowed,
	run,
}: {
	job: Pick<JobDefinition, 'consumer_execution' | 'consumer_history'>;
	userId: UserId;
	editor: boolean;
	triggerAllowed: boolean;
	run?: Pick<JobRun, 'triggered_by'>;
}): JobCapabilities {
	const full = run !== undefined && (editor || run.triggered_by === userId);
	return {
		canTrigger: editor || (job.consumer_execution === true && triggerAllowed),
		history: full ? 'full' : run && job.consumer_history === 'shared' ? 'summary' : 'none',
		canReadHtml: full,
		canReadLogs: run !== undefined && editor,
	};
}

export function toSharedJobRunSummary(run: JobRun): PublicJobRun {
	return {
		run_id: run.run_id,
		job_id: run.job_id,
		notebook_id: run.notebook_id,
		project_id: run.project_id,
		status: run.status,
		trigger: run.trigger,
		triggered_by: run.triggered_by,
		source_version_id: run.source_version_id,
		tags: run.tags,
		...(isTerminalRunStatus(run.status) ? { parameters: run.parameters } : {}),
		attempt: run.attempt,
		retry_of: run.retry_of,
		timeout_seconds: run.timeout_seconds,
		scheduled_for: run.scheduled_for,
		queued_at: run.queued_at,
		eligible_at: run.eligible_at,
		started_at: run.started_at,
		finished_at: run.finished_at,
		deadline_at: run.deadline_at,
		cancelled_by: run.cancelled_by,
	};
}
