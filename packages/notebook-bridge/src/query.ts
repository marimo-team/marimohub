import { NOTEBOOK_PATH_PARAM, notebookPath, validNotebookPath } from './path';

// Keep aligned with marimo's KnownQueryParams when upgrading supported runtimes.
export const RESERVED_PARAMS: ReadonlySet<string> = new Set([
	NOTEBOOK_PATH_PARAM,
	'access_token',
	'refresh_token',
	'session_id',
	'auth_error',
	'theme',
	'show-code',
	'include-code',
	'kiosk',
	'vscode',
	'file',
	'view-as',
	'show-chrome',
]);

export function notebookQueryParams(
	search: string | [string, string][] | URLSearchParams,
	excludedKeys: readonly string[] = [],
): URLSearchParams {
	const params = new URLSearchParams(search);
	for (const key of RESERVED_PARAMS) params.delete(key);
	for (const key of excludedKeys) params.delete(key);
	return params;
}

export function mergeNotebookQuery(
	search: string,
	entries: [string, string][],
	excludedKeys: readonly string[],
	path?: string,
): string {
	const preserved = new URLSearchParams(search);
	// Snapshot keys before deleting: URLSearchParams iterators are live.
	const keys = [...preserved.keys()];
	for (const key of keys) {
		if (!RESERVED_PARAMS.has(key) && !excludedKeys.includes(key)) preserved.delete(key);
	}
	for (const [key, value] of notebookQueryParams(entries, excludedKeys)) {
		preserved.append(key, value);
	}
	if (path !== undefined) {
		preserved.delete(NOTEBOOK_PATH_PARAM);
		if (path && validNotebookPath(path)) preserved.set(NOTEBOOK_PATH_PARAM, path);
	}
	const result = preserved.toString();
	return result ? `?${result}` : '';
}

export function shareableNotebookQuery(
	search: string | [string, string][] | URLSearchParams,
	excludedKeys: readonly string[] = [],
	includePath = true,
): URLSearchParams {
	const params = notebookQueryParams(search, excludedKeys);
	const path = includePath ? notebookPath(new URLSearchParams(search)) : undefined;
	if (path) params.set(NOTEBOOK_PATH_PARAM, path);
	return params;
}
