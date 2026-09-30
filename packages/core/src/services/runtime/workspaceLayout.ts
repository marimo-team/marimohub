import { ConflictError } from '../../errors';
import { isSafeWorkspaceRootPath } from '../../integrations/remoteWorkspace';
import type { VersionPaths } from '../../paths';
import type { GitSource, Source } from '../../schema';

export interface SandboxWorkspaceLayout {
	/** Where workspace files are restored and marimo runs. */
	workdir: string;
	/** Directory holding `.git`: the workdir, or an ancestor of it for a subtree pull source. */
	gitRoot: string;
	/** Workdir relative to the Git root; `''` when they coincide. */
	rootPath: string;
}

/**
 * A pull source's `.git` indexes repository-relative paths, so a subtree
 * workspace cannot sit beside it. The repository root stays at the configured
 * workdir and the session runs from `<workdir>/<root_path>`. An empty root
 * path collapses both directories into one.
 */
export function sandboxWorkspaceLayout(workdir: string, rootPath: string): SandboxWorkspaceLayout {
	// Stored root paths are normalized on write; re-checking here keeps a
	// corrupt record from steering restores outside the workdir.
	if (!isSafeWorkspaceRootPath(rootPath)) {
		throw new ConflictError(`Unsafe workspace root path: ${rootPath}`);
	}
	const gitRoot = workdir.replace(/\/+$/, '') || '/';
	if (!rootPath) return { workdir: gitRoot, gitRoot, rootPath };
	return {
		workdir: gitRoot === '/' ? `/${rootPath}` : `${gitRoot}/${rootPath}`,
		gitRoot,
		rootPath,
	};
}

/** The subtree a pull source mirrors, or `''` when the workspace is the repository root. */
export function pullSourceRootPath(source: Pick<GitSource, 'sync_mode' | 'root_path'>): string {
	return source.sync_mode === 'pull' ? source.root_path : '';
}

/**
 * Provision inputs that only a pull source carries: the version's stored
 * `.git` and the subtree it was mirrored from. Pass the pinned revision's
 * `root_path` when the version is older than the live source settings.
 */
export function pullSourceGitOptions(
	source: Source,
	version: Pick<VersionPaths, 'gitPrefix'> | undefined,
	rootPath?: string,
): { gitPrefix?: string; gitRootPath?: string } {
	if (source.type !== 'git' || source.sync_mode !== 'pull') return {};
	return { gitPrefix: version?.gitPrefix, gitRootPath: rootPath ?? source.root_path };
}
