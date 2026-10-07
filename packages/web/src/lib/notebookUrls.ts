import type { Theme } from '@/context/ThemeContext';

import { notebookQueryParams } from '@marimo-hub/notebook-bridge/query';
import { notebookPath, resolveNotebookPath } from '@marimo-hub/notebook-bridge/path';
export { notebookQueryParams, shareableNotebookQuery } from '@marimo-hub/notebook-bridge/query';

export function notebookFrameUrl(
	url: string,
	search: string,
	theme: Theme,
	isApp: boolean,
): string {
	try {
		const base = new URL(url, window.location.origin);
		const path = notebookPath(search);
		const parsed = path ? (resolveNotebookPath(base, path) ?? base) : base;
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
