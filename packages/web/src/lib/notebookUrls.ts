import type { Theme } from '@/context/ThemeContext';

// Keep aligned with marimo's KnownQueryParams when upgrading the sandbox image.
const RESERVED_PARAMS = new Set([
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

export function notebookQueryParams(search: string): URLSearchParams {
	const params = new URLSearchParams(search);
	for (const key of RESERVED_PARAMS) params.delete(key);
	return params;
}

export function notebookFrameUrl(
	url: string,
	search: string,
	theme: Theme,
	isApp: boolean,
): string {
	try {
		const parsed = new URL(url, window.location.origin);
		const trustedKeys = new Set(parsed.searchParams.keys());
		for (const [key, value] of notebookQueryParams(search)) {
			if (!trustedKeys.has(key)) parsed.searchParams.append(key, value);
		}
		parsed.searchParams.set('theme', theme);
		if (isApp) parsed.searchParams.set('show-code', 'false');
		return parsed.toString();
	} catch {
		return url;
	}
}
