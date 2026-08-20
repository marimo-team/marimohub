import { Gunzip } from 'fflate';
import {
	BadRequestError,
	isSafeWorkspacePath,
	MAX_DECOMPRESSED_ARCHIVE_BYTES,
	UnavailableError,
	ValidationError,
	WorkspaceTarCollector,
} from '@marimo-hub/core';
import type { ArchiveFile } from '@marimo-hub/core';

/**
 * GitHub serves whole-repository tarballs only, so the download itself needs a
 * bound — the workspace caps apply to the *selected* subtree, which says
 * nothing about the rest of a monorepo. 100 MB compressed is far beyond any
 * reasonable source tree while still capping bandwidth and decompression work.
 */
const MAX_COMPRESSED_TARBALL_BYTES = MAX_DECOMPRESSED_ARCHIVE_BYTES;

export function validateCommit(commit: unknown): asserts commit is string {
	if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit)) {
		throw new ValidationError('Invalid GitHub commit SHA');
	}
}

export function validateRootPath(rootPath: unknown): asserts rootPath is string {
	if (typeof rootPath !== 'string' || !isSafeWorkspacePath(rootPath, true)) {
		throw new ValidationError('Invalid workspace root path');
	}
}

/**
 * Map a GitHub tarball entry to its workspace path: strip the tarball's
 * top-level `{repo}-{sha}/` directory, then scope to `rootPath` (entries
 * outside it are skipped, so archive caps apply to the selected tree only).
 */
export function tarballPathMapper(rootPath: string): (path: string) => string | null {
	const prefix = rootPath === '' ? '' : `${rootPath}/`;
	return (path) => {
		const slash = path.indexOf('/');
		if (slash === -1) return null;
		const rest = path.slice(slash + 1);
		if (!rest) return null;
		if (!prefix) return rest;
		return rest.startsWith(prefix) ? rest.slice(prefix.length) : null;
	};
}

function pushCompressed(gunzip: Gunzip, data: Uint8Array, final = false): void {
	try {
		gunzip.push(data, final);
	} catch (error) {
		// The tar collector raises precise BadRequestErrors through the gunzip
		// callback; anything else is gzip-level corruption.
		if (error instanceof BadRequestError) throw error;
		throw new BadRequestError('Invalid gzip archive');
	}
}

/**
 * Stream a repository tarball response into workspace files scoped to
 * `rootPath`. Decompression and tar scanning are incremental: entries outside
 * the root path are discarded as they stream, so a small configured subtree
 * can sync from a repository whose full inflated archive would exceed the
 * ingest caps — only the selected files are buffered and counted.
 */
export async function collectTarballWorkspace(
	response: Response,
	rootPath: string,
): Promise<ArchiveFile[]> {
	const body = response.body;
	if (!body) throw new UnavailableError('GitHub returned an empty tarball response');
	const collector = new WorkspaceTarCollector({ mapPath: tarballPathMapper(rootPath) });
	const gunzip = new Gunzip((data) => collector.push(data));
	const reader = body.getReader();
	let compressed = 0;
	try {
		for (;;) {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await reader.read();
			} catch (error) {
				throw new UnavailableError('GitHub tarball download failed', { cause: error });
			}
			if (result.done) break;
			compressed += result.value.length;
			if (compressed > MAX_COMPRESSED_TARBALL_BYTES) {
				throw new BadRequestError('Repository tarball exceeds the size limit');
			}
			pushCompressed(gunzip, result.value);
		}
		pushCompressed(gunzip, new Uint8Array(0), true);
	} finally {
		await reader.cancel().catch(() => {});
	}
	const files = collector.finish();
	if (!collector.sawEndOfArchive) {
		throw new BadRequestError('Truncated repository tarball');
	}
	return files;
}
