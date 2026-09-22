import type { VersionPaths } from '../../paths';

interface NotebookLaunchSource {
	entryNotebookKey: string;
	workspaceOverlay: { path: string; key: string }[] | undefined;
}

/** Dependency detection and workspace restoration must use the same source version. */
export function resolveNotebookLaunchSource(opts: {
	entryNotebook: string;
	workspacePrefix: string;
	localVersion?: Pick<VersionPaths, 'code' | 'deps'>;
}): NotebookLaunchSource {
	if (opts.localVersion) {
		return {
			entryNotebookKey: opts.localVersion.code,
			workspaceOverlay: [
				{ path: opts.entryNotebook, key: opts.localVersion.code },
				{ path: 'pyproject.toml', key: opts.localVersion.deps },
			],
		};
	}
	return {
		entryNotebookKey: opts.workspacePrefix + opts.entryNotebook,
		workspaceOverlay: undefined,
	};
}
