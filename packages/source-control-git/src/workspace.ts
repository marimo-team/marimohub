import { BadRequestError } from '@marimo-hub/core/errors';
import { isSafeWorkspaceRootPath, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import type { SourceWorkspaceFile } from '@marimo-hub/core/ports/source-control';
import { assertBlobContents, isSafeGitTreePath } from './fileTree';
import type { FileTree, TreeEntry } from './fileTree';

export async function readTreeWorkspace(options: {
	provider: string;
	rootPath: string;
	tree: () => Promise<FileTree>;
	blob: (entry: TreeEntry, limit: number) => Promise<Uint8Array>;
}): Promise<SourceWorkspaceFile[]> {
	if (!isSafeWorkspaceRootPath(options.rootPath))
		throw new BadRequestError('Invalid workspace root path');
	const prefix = options.rootPath ? `${options.rootPath}/` : '';
	const selected = [...(await options.tree())].filter(
		([path, entry]) => path.startsWith(prefix) && ['100644', '100755'].includes(entry.mode),
	);
	if (selected.length > WORKSPACE_LIMITS.maxFiles)
		throw new BadRequestError(`${options.provider} workspace has too many files`);
	const files: SourceWorkspaceFile[] = [];
	let total = 0;
	for (const [path, entry] of selected) {
		// The tree callback is provider code; do not rely on it having validated paths.
		if (!isSafeGitTreePath(path)) throw new BadRequestError(`Unsafe ${options.provider} tree path`);
		const limit = Math.min(WORKSPACE_LIMITS.maxFileBytes, WORKSPACE_LIMITS.maxTotalBytes - total);
		const bytes = await options.blob(entry, limit);
		if (bytes.byteLength > limit)
			throw new BadRequestError(`${options.provider} workspace exceeds the size limit`);
		assertBlobContents(bytes, entry.objectId, options.provider);
		total += bytes.byteLength;
		files.push({ path: path.slice(prefix.length), bytes });
	}
	return files;
}
