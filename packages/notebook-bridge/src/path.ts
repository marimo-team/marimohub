export const NOTEBOOK_PATH_PARAM = '__mh_path';
export const MAX_PATH_LENGTH = 4096;

export function validNotebookPath(path: string): boolean {
	if (path.length > MAX_PATH_LENGTH || path.startsWith('/')) return false;
	// Reject ambiguous encodings before a browser, proxy, or server can normalize them.
	// eslint-disable-next-line no-control-regex -- URL controls must not survive decoding.
	const forbidden = /[\\?#\u0000-\u0020\u007f]/;
	if (forbidden.test(path)) return false;
	try {
		if (new URL(`https://path.invalid/${path}`).pathname.length - 1 > MAX_PATH_LENGTH) return false;
		return path.split('/').every((segment, index) => {
			const decoded = decodeURIComponent(segment);
			return (
				decoded !== '.' &&
				decoded !== '..' &&
				!decoded.includes('/') &&
				!decoded.includes('\\') &&
				!/%[\da-f]{2}/i.test(decoded) &&
				// eslint-disable-next-line no-control-regex -- Encoded controls are unsafe too.
				!/[\u0000-\u001f\u007f]/.test(decoded) &&
				(index !== 0 || !decoded.includes(':'))
			);
		});
	} catch {
		return false;
	}
}

export function notebookPath(search: string | URLSearchParams): string | undefined {
	const paths = new URLSearchParams(search).getAll(NOTEBOOK_PATH_PARAM);
	return paths.length === 1 && validNotebookPath(paths[0]) ? paths[0] : undefined;
}

export function sandboxBasePath(pathname: string): string {
	return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/** Accepts a host-sent base only if it is an already-normalized directory path on `origin`. */
export function parseSandboxBasePath(candidate: string, origin: string): string | undefined {
	try {
		const base = new URL(candidate, origin);
		return base.origin === origin &&
			base.pathname === candidate &&
			candidate.endsWith('/') &&
			!base.search &&
			!base.hash
			? candidate
			: undefined;
	} catch {
		return undefined;
	}
}

export function relativeNotebookPath(pathname: string, basePath: string): string | undefined {
	if (pathname === basePath.slice(0, -1)) return '';
	if (!pathname.startsWith(basePath)) return undefined;
	const path = pathname.slice(basePath.length);
	return validNotebookPath(path) ? path : undefined;
}

export function resolveNotebookPath(base: URL, path: string): URL | undefined {
	if (!validNotebookPath(path)) return undefined;
	const basePath = sandboxBasePath(base.pathname);
	const directory = new URL(base);
	directory.pathname = basePath;
	const resolved = new URL(`./${path}`, directory);
	if (resolved.origin !== base.origin || !resolved.pathname.startsWith(basePath)) return undefined;
	resolved.search = base.search;
	resolved.hash = base.hash;
	return resolved;
}
