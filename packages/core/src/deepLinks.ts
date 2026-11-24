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

export const DeepLinkAccessSchema = z
	.strictObject({
		mode: z.enum(['inherit', 'public']),
		grant_id: ulidString().optional(),
		enabled_by: UserIdSchema.optional(),
		enabled_at: utcTimestamp().optional(),
		allow_project_integrations: z.boolean().optional(),
	})
	.superRefine((access, ctx) => {
		if (access.mode === 'inherit') {
			for (const field of [
				'grant_id',
				'enabled_by',
				'enabled_at',
				'allow_project_integrations',
			] as const) {
				if (access[field] !== undefined) {
					ctx.addIssue({
						code: 'custom',
						path: [field],
						message: `${field} is only allowed when mode is "public"`,
					});
				}
			}
			return;
		}
		for (const field of ['grant_id', 'enabled_by', 'enabled_at'] as const) {
			if (access[field] === undefined) {
				ctx.addIssue({
					code: 'custom',
					path: [field],
					message: `${field} is required when mode is "public"`,
				});
			}
		}
	});

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

export type DeepLinkAccess = z.infer<typeof DeepLinkAccessSchema>;
export type PublicDeepLinkAccess = {
	mode: 'public';
	grant_id: string;
	enabled_by: z.infer<typeof UserIdSchema>;
	enabled_at: string;
	allow_project_integrations?: boolean;
};
export type DeepLink = z.infer<typeof DeepLinkSchema>;
export type DeepLinkTarget = z.infer<typeof DeepLinkTargetSchema>;

export function isPublicDeepLink(
	link: Pick<DeepLink, 'access'>,
): link is DeepLink & { access: PublicDeepLinkAccess } {
	return (
		link.access.mode === 'public' &&
		typeof link.access.grant_id === 'string' &&
		typeof link.access.enabled_by === 'string' &&
		typeof link.access.enabled_at === 'string'
	);
}
