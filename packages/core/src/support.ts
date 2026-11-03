import { z } from 'zod';
import {
	NotebookIdSchema,
	ProjectIdSchema,
	RuntimeSchema,
	SessionIdSchema,
	UserIdSchema,
} from './schema';

export const SUPPORT_LIMITS = {
	message: 2000,
	userAgent: 512,
	clientError: 1000,
} as const;

export const SupportContextSchema = z.object({
	page_url: z.string().max(2048),
	client: z.object({
		user_agent: z.string().max(SUPPORT_LIMITS.userAgent),
		viewport: z.object({
			width: z.number().int().min(0).max(100_000),
			height: z.number().int().min(0).max(100_000),
		}),
		error: z.string().max(SUPPORT_LIMITS.clientError).optional(),
	}),
	session: z
		.object({
			project_id: ProjectIdSchema,
			notebook_id: NotebookIdSchema,
			id: SessionIdSchema,
		})
		.optional(),
});

export const SupportDiagnosticsSchema = SupportContextSchema.extend({
	reporter: z.object({ id: UserIdSchema, email: z.string() }),
	hub_version: z.string(),
	timestamp: z.string(),
	session: SupportContextSchema.shape.session
		.unwrap()
		.extend({
			source_version_id: z.string().optional(),
			sandbox_id: z.string().optional(),
			runtime: RuntimeSchema.optional(),
			compute_profile: z.string().optional(),
			error: z.object({ code: z.string(), message: z.string() }).optional(),
		})
		.optional(),
});

export const SupportRequestSchema = SupportContextSchema.extend({
	message: z.string().trim().min(1).max(SUPPORT_LIMITS.message),
});
export type SupportContext = z.infer<typeof SupportContextSchema>;
export type SupportDiagnostics = z.infer<typeof SupportDiagnosticsSchema>;

export function supportPageUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
		return `${url.origin}${url.pathname}`;
	} catch {
		return '';
	}
}
