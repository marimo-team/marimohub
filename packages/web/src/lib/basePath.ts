import { basePathFromUrl, normalizeBasePath } from '@marimo-hub/core/url';

export function appBasePath(
	baseUri = document.querySelector<HTMLBaseElement>('base[href]')?.href ?? window.location.origin,
): string {
	return basePathFromUrl(baseUri);
}

export function withBasePath(path: string, basePath = appBasePath()): string {
	if (!path.startsWith('/') || path.startsWith('//')) return path;
	const prefix = normalizeBasePath(basePath);
	if (prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)) return path;
	return `${prefix}${path}`;
}
