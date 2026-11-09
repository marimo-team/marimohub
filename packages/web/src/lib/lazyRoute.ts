import { lazy } from 'react';
import type { FunctionComponent } from 'react';

const RELOAD_KEY = 'marimohub:chunk-reload';

export function isChunkLoadError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'ChunkLoadError' ||
			/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
				error.message,
			))
	);
}

export async function loadRoute<T>(
	load: () => Promise<T>,
	reload = () => window.location.reload(),
): Promise<T> {
	try {
		return await load();
	} catch (error) {
		if (isChunkLoadError(error)) {
			try {
				// Keep the tab-wide guard across reloads and successful imports to prevent loops.
				if (!sessionStorage.getItem(RELOAD_KEY)) {
					sessionStorage.setItem(RELOAD_KEY, '1');
					reload();
				}
			} catch {
				// Without persistent storage, automatic reloads could loop.
			}
		}
		throw error;
	}
}

export function lazyRoute<Props extends object>(
	load: () => Promise<{ default: FunctionComponent<Props> }>,
) {
	return lazy(() => loadRoute(load));
}
