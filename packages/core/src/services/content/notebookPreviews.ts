import { z } from 'zod';
import {
	NotebookIdSchema,
	PreviewIdSchema,
	ProjectIdSchema,
	SessionIdSchema,
	UserIdSchema,
	VersionIdSchema,
} from '../../schema';
import type { NotebookId, ProjectId } from '../../ids';

export { PreviewIdSchema } from '../../schema';
export const PreviewSourceSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('branch'),
		branch: z
			.string()
			.min(1)
			.regex(
				// Git refs cannot contain ASCII controls or ref-expression operators.
				// eslint-disable-next-line no-control-regex
				/^(?!@(?:$|\{))(?![-/])(?!.*(?:\.\.|\/\/|@\{|[\x00-\x20\x7f~^:?*[\\]))(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))[^/]+(?:\/[^/]+)*(?<![/.])$/,
			),
	}),
	z.strictObject({ type: z.literal('commit'), commit: z.string().regex(/^[a-fA-F0-9]{40}$/) }),
]);
export const PreviewCreateSchema = z.strictObject({
	name: z.string().trim().min(1).max(100),
	source: PreviewSourceSchema,
	compute_profile: z.string().min(1).optional(),
	expires_at: z.iso.datetime().optional(),
	pull_request: z.number().int().positive().optional(),
});
export const PreviewRecordSchema = z.object({
	schema_version: z.literal(1),
	id: PreviewIdSchema,
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
	name: z.string(),
	source: PreviewSourceSchema,
	repository: z.string(),
	root_path: z.string(),
	entry_notebook: z.string(),
	compute_profile: z.string().optional(),
	expires_at: z.iso.datetime(),
	pull_request: z.number().int().positive().optional(),
	created_by: UserIdSchema,
	created_at: z.iso.datetime(),
	request_fingerprint: z.string(),
	state: z.enum(['active', 'deleting', 'deleted']),
	preparation: z.enum(['pending', 'preparing', 'ready', 'failed']),
	checked_at: z.iso.datetime().optional(),
	next_attempt_at: z.number().optional(),
	preparation_failures: z.number().int().nonnegative().default(0),
	error: z.string().optional(),
	lease: z
		.object({
			token: z.string(),
			expires_at: z.number().describe('Lease deadline in milliseconds since the Unix epoch.'),
		})
		.optional(),
	current: z
		.object({ notebook_id: NotebookIdSchema, version_id: VersionIdSchema, commit: z.string() })
		.optional(),
	revisions: z.array(
		z.object({
			notebook_id: NotebookIdSchema,
			state: z.enum(['preparing', 'ready', 'retiring']),
			cleanup_after: z.number(),
		}),
	),
	admissions: z
		.array(
			z.object({
				session_id: SessionIdSchema,
				notebook_id: NotebookIdSchema,
				expires_at: z
					.number()
					.describe('Uncommitted admission deadline in milliseconds since the Unix epoch.'),
				committed: z.boolean().default(false),
			}),
		)
		.default([]),
	cleanup_after: z
		.number()
		.describe('Earliest ownership removal time in milliseconds since the Unix epoch.')
		.optional(),
});
export type NotebookPreview = z.infer<typeof PreviewRecordSchema>;
export type PreviewCreate = z.infer<typeof PreviewCreateSchema>;
export const previewPrefix = (pid: ProjectId, nid: NotebookId) => `_system/previews/${pid}/${nid}/`;
export const previewKey = (pid: ProjectId, nid: NotebookId, id: string) =>
	`${previewPrefix(pid, nid)}${id}.json`;
export const PREVIEW_POLL_MS = 60_000;
export const PREVIEW_IDLE_MS = 5 * 60_000;
export const PREVIEW_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
