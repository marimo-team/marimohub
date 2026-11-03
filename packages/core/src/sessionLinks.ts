import { z } from 'zod';
import { parseHttpUrl } from './url';

const PLACEHOLDERS = ['sandbox_id', 'session_id', 'project_id', 'notebook_id'] as const;
const PLACEHOLDER_PATTERN = new RegExp(`\\{(${PLACEHOLDERS.join('|')})\\}`, 'g');

function isSessionLinkTemplate(value: string): boolean {
	if (/[\s\\\p{Cc}]/u.test(value)) return false;
	const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
	if (!authority || /[{}]/u.test(authority)) return false;
	const resolved = value.replace(PLACEHOLDER_PATTERN, 'id');
	if (/[{}]/u.test(resolved)) return false;
	const parsed = parseHttpUrl(resolved);
	return parsed.ok && !/[{}]/u.test(parsed.url.hostname);
}

export const SessionLinkTemplateSchema = z.strictObject({
	id: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/),
	label: z.string().trim().min(1).max(40),
	href_template: z
		.string()
		.trim()
		.min(1)
		.max(2048)
		.refine(isSessionLinkTemplate, {
			message: `Use an HTTP(S) URL with a fixed host and no credentials. Allowed path, query, or fragment placeholders: ${PLACEHOLDERS.map((key) => `{${key}}`).join(', ')}.`,
		}),
});

export const SessionLinkTemplatesSchema = z
	.array(SessionLinkTemplateSchema)
	.max(12)
	.refine((links) => new Set(links.map((link) => link.id)).size === links.length, {
		message: 'Session link IDs must be unique',
	});

export type SessionLinkTemplate = z.infer<typeof SessionLinkTemplateSchema>;

export const SessionLinkSchema = z.object({
	id: z.string(),
	label: z.string(),
	href: z.string(),
});

type SessionLinkContext = Partial<Record<(typeof PLACEHOLDERS)[number], string>>;

export function resolveSessionLinks(
	templates: readonly SessionLinkTemplate[],
	context: SessionLinkContext,
): z.infer<typeof SessionLinkSchema>[] {
	return templates.flatMap(({ id, label, href_template }) => {
		let missing = false;
		const href = href_template.replace(PLACEHOLDER_PATTERN, (_, key: keyof SessionLinkContext) => {
			const value = context[key];
			if (!value) missing = true;
			return encodeURIComponent(value ?? '');
		});
		return missing ? [] : [{ id, label, href }];
	});
}
