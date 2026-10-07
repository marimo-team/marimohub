import type { Theme } from '@/context/ThemeContext';

import {
	mergeNotebookQuery,
	notebookFrameUrl as sandboxFrameUrl,
	notebookQueryParams,
	sandboxQueryKeys,
} from '@marimo-hub/notebook-bridge/query';
export { notebookQueryParams, shareableNotebookQuery } from '@marimo-hub/notebook-bridge/query';

export function trustedSandboxKeys(sandboxUrl: string): string[] {
	return sandboxQueryKeys(new URL(sandboxUrl, window.location.origin));
}

/** The same Hub query without the saved sandbox page path. */
export function notebookHomeSearch(search: string): string {
	return mergeNotebookQuery(search, [...notebookQueryParams(search)], [], '');
}

export function notebookFrameUrl(
	url: string,
	search: string,
	theme: Theme,
	isApp: boolean,
): string {
	try {
		const parsed = sandboxFrameUrl(new URL(url, window.location.origin), search);
		parsed.searchParams.set('theme', theme);
		if (isApp) parsed.searchParams.set('show-code', 'false');
		return parsed.toString();
	} catch {
		return url;
	}
}
