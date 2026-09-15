import { z } from 'zod';
import { NotebookIdSchema, ProjectIdSchema, UserIdSchema } from './schema';

// An absolute end assertion rejects trailing newlines, which `$` accepts.
export const DeepLinkSlugSchema = z
	.string()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?![\s\S])/);
export const DeepLinkTargetSchema = z.strictObject({
	kind: z.literal('app'),
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
});
export const DeepLinkAccessSchema = z.strictObject({ mode: z.literal('inherit') });
export const DeepLinkSchema = z.strictObject({
	schema_version: z.literal(1),
	registration_id: z.ulid(),
	slug: DeepLinkSlugSchema,
	target: DeepLinkTargetSchema,
	access: DeepLinkAccessSchema,
	created_by: UserIdSchema,
	created_at: z.iso.datetime(),
});
export const DeepLinkRecordSchema = z.union([
	DeepLinkSchema,
	z.strictObject({
		schema_version: z.literal(1),
		released: z.literal(true),
		registration_id: z.ulid(),
	}),
]);
export type DeepLink = z.infer<typeof DeepLinkSchema>;
export type DeepLinkTarget = z.infer<typeof DeepLinkTargetSchema>;
