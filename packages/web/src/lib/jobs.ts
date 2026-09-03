import type { JobRun, JobRunStatus } from '@/types';

const PARAMETER_LINE = /^([A-Za-z][A-Za-z0-9_-]{0,63})=(.*)$/;

export function parseJobParameters(text: string): Record<string, string> {
	const parameters: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (!line.trim()) continue;
		const match = PARAMETER_LINE.exec(line);
		if (!match) throw new Error(`"${line}" is not key=value (keys: letters, digits, _ or -)`);
		let value = match[2];
		if (value.startsWith('"')) {
			try {
				const parsed: unknown = JSON.parse(value);
				if (typeof parsed !== 'string') throw new Error('Parameter value must be a string');
				value = parsed;
			} catch {
				throw new Error(`The value for "${match[1]}" is not a valid JSON string`);
			}
		}
		parameters[match[1]] = value;
	}
	return parameters;
}

export function formatJobParameters(parameters: Record<string, string> | undefined): string {
	return Object.entries(parameters ?? {})
		.map(([key, value]) => {
			const needsQuotes =
				value.startsWith('"') ||
				value.trim() !== value ||
				value.includes('\n') ||
				value.includes('\r');
			return `${key}=${needsQuotes ? JSON.stringify(value) : value}`;
		})
		.join('\n');
}

export const TERMINAL_RUN_STATUSES: readonly JobRunStatus[] = [
	'succeeded',
	'failed',
	'timed_out',
	'cancelled',
	'skipped',
];

export function isTerminalRun(run: Pick<JobRun, 'status'>): boolean {
	return TERMINAL_RUN_STATUSES.includes(run.status);
}

export const RUN_STATUS_LABELS: Record<JobRunStatus, string> = {
	queued: 'Queued',
	provisioning: 'Starting',
	running: 'Running',
	succeeded: 'Succeeded',
	failed: 'Failed',
	timed_out: 'Timed out',
	cancelled: 'Cancelled',
	skipped: 'Skipped',
	unknown: 'Unknown',
};

/** Tailwind classes for the status chip: a live run pulses, an outcome is colored. */
export function runStatusClasses(status: JobRunStatus): string {
	switch (status) {
		case 'succeeded':
			return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
		case 'failed':
		case 'timed_out':
			return 'border-destructive/30 bg-destructive/10 text-destructive';
		case 'provisioning':
		case 'running':
			return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
		case 'queued':
		case 'cancelled':
		case 'skipped':
		case 'unknown':
			return 'border-border bg-muted text-muted-foreground';
	}
}

/** "Every day at 06:00 (Europe/Berlin)"-style summary is out of scope; show the cron verbatim. */
export function describeSchedule(job: { schedule?: { cron: string; timezone: string } }): string {
	if (!job.schedule) return 'Manual only';
	return `${job.schedule.cron} · ${job.schedule.timezone}`;
}

export function runDurationMs(
	run: Pick<JobRun, 'started_at' | 'finished_at'>,
	now: number,
): number | null {
	if (!run.started_at) return null;
	const end = run.finished_at ? Date.parse(run.finished_at) : now;
	const start = Date.parse(run.started_at);
	return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}
