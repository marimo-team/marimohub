import type { Millis } from '../../duration';
import type { JobDefinition } from '../../schema';

export function jobTimeoutSeconds(
	job: Pick<JobDefinition, 'timeout_seconds'>,
	config: { defaultTimeoutMs: Millis; maxTimeoutMs: Millis },
): number {
	const requested =
		job.timeout_seconds === undefined ? config.defaultTimeoutMs : job.timeout_seconds * 1000;
	return Math.floor(Math.min(requested, config.maxTimeoutMs) / 1000);
}
