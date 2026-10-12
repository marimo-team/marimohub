import { z } from '@hono/zod-openapi';
import {
	isValidTagNamespace,
	MAX_TAG_NAMESPACE_LENGTH,
	PATH_TAG_PATTERN,
} from '@marimo-hub/core/tag-paths';

const MAX_TAGS = 50;

const PATH_TAG_RULES =
	'Segments are separated by `/`. Each segment must start with a lowercase letter or digit, followed by lowercase letters, digits, `.`, `_`, or `-`.';

export const TAG_NAMESPACE_DESCRIPTION = `Path-tag namespace. Matches whole path segments: \`research\` matches \`research\` and \`research/vision\`, but not \`researchx\`. ${PATH_TAG_RULES}`;

export const TagNamespaceSchema = z
	.string()
	.refine(isValidTagNamespace, `Expected a path-tag namespace. ${PATH_TAG_RULES}`)
	.meta({ maxLength: MAX_TAG_NAMESPACE_LENGTH, pattern: PATH_TAG_PATTERN.source });

/** An empty value means no filter, matching `?q=`; the REST query and MCP tool share it. */
export const OptionalTagNamespaceSchema = z.preprocess(
	(value) => (value === '' ? undefined : value),
	TagNamespaceSchema.optional(),
);

export const TagsBodySchema = z
	.array(z.string().min(1).max(MAX_TAG_NAMESPACE_LENGTH))
	.max(MAX_TAGS);
