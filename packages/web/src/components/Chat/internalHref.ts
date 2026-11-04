/**
 * Browsers treat both `//host` and `/\\host` as protocol-relative, so neither is an
 * in-app path. They also drop ASCII tab and newlines while parsing, so `/\t/host`
 * must be judged after the same stripping.
 */
export function isInternalHref(href: string): boolean {
	const cleaned = href.replaceAll(/[\t\n\r]/g, '');
	return cleaned.startsWith('/') && cleaned[1] !== '/' && cleaned[1] !== '\\';
}
