import { utcTimestamp, ulidString } from './stringFormats';
import { z } from 'zod';
import { NotebookIdSchema, ProjectIdSchema, UserIdSchema } from './schema';
import { DeepLinkSlugSchema } from './deepLinkSlug';
export { DeepLinkSlugSchema } from './deepLinkSlug';

export const DeepLinkTargetSchema = z.strictObject({
	kind: z.literal('app'),
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
});
export const DeepLinkAccessSchema = z.strictObject({ mode: z.literal('inherit') });
export const DeepLinkSchema = z.strictObject({
	schema_version: z.literal(1),
	registration_id: ulidString(),
	slug: DeepLinkSlugSchema,
	target: DeepLinkTargetSchema,
	access: DeepLinkAccessSchema,
	created_by: UserIdSchema,
	created_at: utcTimestamp(),
});
export const DeepLinkRecordSchema = z.union([
	DeepLinkSchema,
	z.strictObject({
		schema_version: z.literal(1),
		released: z.literal(true),
		registration_id: ulidString(),
	}),
]);
export type DeepLink = z.infer<typeof DeepLinkSchema>;
export type DeepLinkTarget = z.infer<typeof DeepLinkTargetSchema>;
