import type { VersionPaths } from '../../paths';
import type { LocalPublicationVersion } from '../../schema';

interface NotebookLaunchSource {
	entryNotebookKey: string;
	workspaceOverlay: { path: string; key: string }[] | undefined;
	workspaceRemovePaths?: string[];
}

/** Dependency detection and workspace restoration must use the same source version. */
export function resolveNotebookLaunchSource(opts: {
	entryNotebook: string;
	workspacePrefix: string;
	localVersion?: Pick<VersionPaths, 'code' | 'deps' | 'session' | 'capture'>;
	localCapture?: LocalPublicationVersion;
}): NotebookLaunchSource {
	if (opts.localVersion) {
		const session = opts.localCapture?.session_snapshot;
		const segments = opts.entryNotebook.split('/');
		const filename = segments.pop()!;
		const sessionPath = [...segments, '__marimo__', 'session', `${filename}.json`].join('/');
		return {
			entryNotebookKey: opts.localVersion.code,
			...(opts.localCapture && !session ? { workspaceRemovePaths: [sessionPath] } : {}),
			workspaceOverlay: [
				{ path: opts.entryNotebook, key: opts.localVersion.code },
				{ path: 'pyproject.toml', key: opts.localVersion.deps },
				...(session
					? [
							{
								path: sessionPath,
								key: session.capture_id
									? opts.localVersion.capture(session.capture_id).session
									: opts.localVersion.session,
							},
						]
					: []),
			],
		};
	}
	return {
		entryNotebookKey: opts.workspacePrefix + opts.entryNotebook,
		workspaceOverlay: undefined,
	};
}
