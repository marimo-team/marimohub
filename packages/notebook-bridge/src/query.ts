// Keep aligned with marimo's KnownQueryParams when upgrading supported runtimes.
export const RESERVED_PARAMS: ReadonlySet<string> = new Set([
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
	const result = preserved.toString();
	return result ? `?${result}` : '';
}
