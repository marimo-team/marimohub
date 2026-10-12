export const PATH_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?![\s\S])/;
export const MAX_TAG_NAMESPACE_LENGTH = 256;

export function isPathTag(tag: string): boolean {
	return PATH_TAG_PATTERN.test(tag);
}

export function isValidTagNamespace(value: string): boolean {
	return value.length <= MAX_TAG_NAMESPACE_LENGTH && isPathTag(value);
}

/** Matches whole path segments: `a` contains `a` and `a/b`, but not `ab`. */
export function tagInNamespace(tag: string, namespace: string): boolean {
	return (
		isPathTag(namespace) && isPathTag(tag) && (tag === namespace || tag.startsWith(`${namespace}/`))
	);
}

export function tagsInNamespace(tags: readonly string[], namespace: string): boolean {
	return tags.some((tag) => tagInNamespace(tag, namespace));
}

export function childSegment(tag: string, namespace?: string): string | undefined {
	if (!isPathTag(tag)) return undefined;
	if (namespace === undefined) return tag.split('/')[0];
	if (!tagInNamespace(tag, namespace) || tag === namespace) return undefined;
	return tag.slice(namespace.length + 1).split('/')[0];
}
