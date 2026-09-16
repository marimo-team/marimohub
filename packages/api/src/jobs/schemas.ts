import { z } from '@hono/zod-openapi';
import {
	JOB_CONCURRENCY_POLICIES,
	JOB_NOTIFICATION_EVENTS,
	JOB_PARAMETER_KEY_PATTERN,
	JOB_PARAMETERS_JSON_SCHEMA,
	JobId,
	MAX_JOB_NAME_LENGTH,
	MAX_JOB_PARAMETER_VALUE_LENGTH,
	MAX_JOB_PARAMETERS,
	MAX_JOB_RETRIES,
	MAX_JOB_RETRY_BACKOFF_SECONDS,
	MIN_JOB_TIMEOUT_SECONDS,
	RUN_STATUSES,
	RUN_TRIGGERS,
	RunId,
} from '@marimo-hub/core';
import { ComputeResourcesResponseSchema, extensibleResponseEnum } from '../shared';

export const JobScheduleShape = z.object({
	cron: z.string().min(1).max(100).openapi({
		description: 'Five-field cron expression (minute hour day-of-month month day-of-week).',
		example: '0 6 * * 1-5',
	}),
	timezone: z.string().min(1).max(64).openapi({
		description: 'IANA time zone the cron fields are evaluated in.',
		example: 'Europe/Berlin',
	}),
});
const JobScheduleSchema = JobScheduleShape.openapi('JobSchedule');

const JobRetryPolicyShape = z.object({
	max_retries: z.number().int().min(0).max(MAX_JOB_RETRIES),
	backoff_seconds: z.number().int().min(0).max(MAX_JOB_RETRY_BACKOFF_SECONDS).default(60),
});
const JobRetryPolicySchema = JobRetryPolicyShape.openapi('JobRetryPolicy');

const JobParametersShape = z
	.record(
		z.string().regex(JOB_PARAMETER_KEY_PATTERN),
		z.string().max(MAX_JOB_PARAMETER_VALUE_LENGTH),
	)
	.refine((parameters) => Object.keys(parameters).length <= MAX_JOB_PARAMETERS, {
		message: `At most ${MAX_JOB_PARAMETERS} parameters are allowed`,
	})
	.meta(JOB_PARAMETERS_JSON_SCHEMA);
const JobParametersSchema = JobParametersShape.openapi('JobParameters', {
	description:
		'String parameters passed to the notebook as `--key value` after `--`, readable via `mo.cli_args()`. Parameters are visible to every project member who can read the job or its run history; do not store secrets here.',
	example: { region: 'eu-west-1' },
});

const JobNotificationsShape = z.object({
	on: z
		.array(z.enum(JOB_NOTIFICATION_EVENTS))
		.min(1)
		.refine((events) => new Set(events).size === events.length, {
			message: 'Notification events must be unique',
		})
		.meta({ uniqueItems: true }),
});
const JobNotificationsSchema = JobNotificationsShape.openapi('JobNotifications', {
	description:
		'Deliver `job.run.failed` / `job.run.succeeded` project alerts for this job. Failures notify once retries are exhausted.',
});

const TimeoutSchema = z.number().int().min(MIN_JOB_TIMEOUT_SECONDS).openapi({
	description: 'Run deadline in seconds; capped by MARIMOHUB_JOBS_MAX_TIMEOUT_SECONDS.',
	example: 1800,
});

export const CreateJobBody = z
	.strictObject({
		name: z.string().min(1).max(MAX_JOB_NAME_LENGTH).openapi({ example: 'Nightly refresh' }),
		enabled: z.boolean().default(true),
		/** Absent = manual-trigger only. */
		schedule: JobScheduleSchema.optional(),
		parameters: JobParametersSchema.optional(),
		retry: JobRetryPolicySchema.optional(),
		timeout_seconds: TimeoutSchema.optional(),
		concurrency_policy: z.enum(JOB_CONCURRENCY_POLICIES).default('forbid'),
		notifications: JobNotificationsSchema.optional(),
	})
	.openapi('JobCreateBody');

export const UpdateJobBody = z
	.strictObject({
		name: z.string().min(1).max(MAX_JOB_NAME_LENGTH).optional(),
		enabled: z.boolean().optional(),
		// Inline (unnamed) shapes: a nullable `$ref` renders as an `allOf` the
		// generated client cannot assign `null` to.
		schedule: JobScheduleShape.nullable().optional(),
		parameters: JobParametersShape.nullable().optional(),
		retry: JobRetryPolicyShape.nullable().optional(),
		timeout_seconds: TimeoutSchema.nullable().optional(),
		concurrency_policy: z.enum(JOB_CONCURRENCY_POLICIES).optional(),
		notifications: JobNotificationsShape.nullable().optional(),
	})
	.refine((body) => Object.values(body).some((value) => value !== undefined), {
		message: 'At least one field is required.',
	})
	.openapi('JobUpdateBody');

export const TriggerRunBody = z
	.strictObject({
		/** Overrides the job's stored parameters for this run only. */
		parameters: JobParametersSchema.optional(),
	})
	.openapi('JobRunTriggerBody');

export const JobResponseSchema = z
	.object({
		id: z.string().regex(JobId.regex),
		notebook_id: z.string(),
		project_id: z.string(),
		name: z.string(),
		enabled: z.boolean(),
		schedule: JobScheduleSchema.optional(),
		parameters: JobParametersSchema.optional(),
		retry: JobRetryPolicySchema.optional(),
		timeout_seconds: z.number().int().optional(),
		concurrency_policy: extensibleResponseEnum(JOB_CONCURRENCY_POLICIES, 'forbid'),
		notifications: JobNotificationsSchema.optional(),
		created_by: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.openapi('Job');

const RunErrorSchema = z.object({ code: z.string(), message: z.string() });

export const JobRunResponseSchema = z
	.object({
		run_id: z.string().regex(RunId.regex),
		job_id: z.string(),
		notebook_id: z.string(),
		project_id: z.string(),
		status: extensibleResponseEnum(RUN_STATUSES, 'queued').openapi({
			description:
				'queued/provisioning/running are active. succeeded/failed/timed_out/cancelled/skipped are terminal; terminal records are never rewritten.',
		}),
		trigger: extensibleResponseEnum(RUN_TRIGGERS, 'manual'),
		triggered_by: z.string().optional(),
		scheduled_for: z.iso.datetime().optional(),
		source_version_id: z.string().optional(),
		parameters: JobParametersSchema.optional(),
		attempt: z.number().int().positive().openapi({
			description:
				'One-based attempt number. A failed or timed-out attempt can create a new run with attempt + 1 and retry_of set, subject to the job retry policy.',
		}),
		retry_of: z.string().optional(),
		image: z.string().optional(),
		compute_profile: z.string().optional(),
		compute_resources: ComputeResourcesResponseSchema.optional(),
		timeout_seconds: z.number().int(),
		queued_at: z.iso.datetime(),
		eligible_at: z.iso.datetime().optional(),
		started_at: z.iso.datetime().optional().openapi({
			description: 'Present after the run enters running.',
		}),
		finished_at: z.iso.datetime().optional().openapi({
			description: 'Present on terminal runs.',
		}),
		deadline_at: z.iso.datetime().optional().openapi({
			description: 'Present after provisioning establishes the watchdog deadline.',
		}),
		exit_code: z.number().int().optional().openapi({
			description: 'Process exit code when the export command reported one.',
		}),
		error: RunErrorSchema.optional().openapi({
			description: 'Sanitized failure detail, present on failed, timed-out, or skipped runs.',
		}),
		output: z
			.object({
				html_bytes: z.number().int().nonnegative(),
				logs_bytes: z.number().int().nonnegative().optional(),
			})
			.optional()
			.openapi({ description: 'Captured write-once artifacts, present after execution.' }),
		cancelled_by: z.string().optional(),
	})
	.openapi('JobRun');
