import { z } from 'zod';
import { utcTimestamp } from '../../stringFormats';

export const MigrationProgressSchema = z
	.object({
		processed: z.number().int().nonnegative(),
		total: z.number().int().nonnegative().optional(),
		partial: z.boolean(),
	})
	.refine((value) => value.total === undefined || value.total >= value.processed);

export const MigrationFailureSchema = z.object({
	code: z.enum(['migration_failed', 'timeout']),
	at: utcTimestamp(),
});

const migrationActivityFields = {
	started_at: utcTimestamp().optional(),
	last_attempt_at: utcTimestamp().optional(),
	last_progress_at: utcTimestamp().optional(),
	attempts: z.number().int().nonnegative().optional(),
	progress: MigrationProgressSchema.optional(),
};

export const migrationTelemetry = {
	...migrationActivityFields,
	waiting_reason: z.literal('waiting_for_initialization').optional(),
	failure: MigrationFailureSchema.optional(),
};

export interface MigrationDescriptor {
	/** Permanent identity: change the ID when changing the migration's meaning. */
	id: string;
	title?: string;
	description?: string;
	impact?: string;
	progressUnit?: string;
}

export const MigrationRowSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string(),
	impact: z.string(),
	progress_unit: z.string().optional(),
	retired: z.boolean(),
	status: z.enum([
		'waiting',
		'initializing',
		'dependency',
		'running',
		'resuming',
		'retrying',
		'blocked',
		'unavailable',
		'completed',
		'not_recorded',
	]),
	dependencies: z.array(z.string()),
	...migrationActivityFields,
	completed_at: utcTimestamp().optional(),
	failure: MigrationFailureSchema.extend({ message: z.string() }).optional(),
});
export const MigrationInspectionSchema = z.object({
	rows: z.array(MigrationRowSchema),
	observed_at: utcTimestamp(),
	incomplete: z.boolean(),
	counts: z.object({
		waiting: z.number(),
		running: z.number(),
		completed: z.number(),
		needs_attention: z.number(),
	}),
	action: z.enum(['ready', 'already_complete', 'blocked', 'unavailable']),
	poll: z.boolean(),
});
export type MigrationRow = z.infer<typeof MigrationRowSchema>;
export type MigrationInspection = z.infer<typeof MigrationInspectionSchema>;
