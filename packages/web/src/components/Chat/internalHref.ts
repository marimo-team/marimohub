/** Browsers treat both `//host` and `/\\host` as protocol-relative, so neither is an in-app path. */
export function isInternalHref(href: string): boolean {
	return href.startsWith('/') && href[1] !== '/' && href[1] !== '\\';
}
