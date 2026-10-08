export const PATH_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?![\s\S])/;
export const MAX_TAG_PREFIX_LENGTH = 256;

export function isPathTag(tag: string): boolean {
	return PATH_TAG_PATTERN.test(tag);
}

export function tagMatchesPrefix(tag: string, prefix: string): boolean {
	return isPathTag(prefix) && isPathTag(tag) && (tag === prefix || tag.startsWith(`${prefix}/`));
}

export function tagsMatchPrefix(tags: readonly string[], prefix: string): boolean {
	return tags.some((tag) => tagMatchesPrefix(tag, prefix));
}

export function childSegment(tag: string, prefix?: string): string | undefined {
	if (!isPathTag(tag)) return undefined;
	if (prefix === undefined) return tag.split('/')[0];
	if (!tagMatchesPrefix(tag, prefix) || tag === prefix) return undefined;
	return tag.slice(prefix.length + 1).split('/')[0];
}
