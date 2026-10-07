import type { ByteBudget } from './byteBudget';
import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { listFilesFailure } from '../../ports/sandbox';
import type {
	FileInfo,
	ListFilesResult,
	ReadFileResult,
	SandboxInstance,
} from '../../ports/sandbox';
import {
	MAX_ARTIFACT_BYTES,
	MAX_WORKSPACE_BYTES,
	MAX_WORKSPACE_FILE_BYTES,
	MAX_WORKSPACE_FILES,
} from '../../constants';
import { shellQuote } from './shell';
import {
	DEFAULT_LOCAL_ENTRY_NOTEBOOK,
	isSafeWorkspacePath,
	isWorkspaceInternalPath,
	workspaceDirectoryFromMarkerPath,
	workspaceDirectoryMarkerPath,
} from '../../integrations/remoteWorkspace';
import { isRegenerableArtifactPath } from '../../integrations/workspaceIgnore';
import { listAllKeys, listAllObjects } from '../catalog/storage';
import type { CommitSessionInput } from '../content/NotebookService';

/**
 * Restore GETs touch only the object store and byte-bounded API memory, so they
 * can fan out further than capture reads, which contend on the sandbox command
 * channel.
 */
const RESTORE_FETCH_CONCURRENCY = 32;
const CAPTURE_FILE_CONCURRENCY = 8;
// Reserve a full per-file budget for each read/upload slot, regardless of listed size.
const CAPTURE_READ_CONCURRENCY = Math.min(
	CAPTURE_FILE_CONCURRENCY,
	Math.floor(MAX_WORKSPACE_BYTES / MAX_WORKSPACE_FILE_BYTES),
);
const CAPTURE_READ_TIMEOUT_MS = 10_000;
const warnedUnsupportedSandboxes = new WeakSet<SandboxInstance>();

function supportsBoundedReads(sandbox: SandboxInstance): boolean {
	if (typeof sandbox.readFileBounded === 'function') return true;
	if (!warnedUnsupportedSandboxes.has(sandbox)) {
		warnedUnsupportedSandboxes.add(sandbox);
		console.warn(
			'Sandbox adapter does not implement readFileBounded; artifact and workspace capture are disabled. ' +
				'New sandbox changes will not be saved; stored content is preserved. ' +
				'Implement readFileBounded to enable capture.',
		);
	}
	return false;
}

/**
 * Attempts for an idempotent sandbox write. A backend stream can reset mid-call
 * (see RUNBOOK H1: a transient gRPC `ECONNRESET` took down a replica); replaying
 * the same bytes to the same path is safe, so a failed restore should not sink
 * the whole session.
 */
const SANDBOX_WRITE_ATTEMPTS = 3;

/**
 * Bytes of workspace held in memory at once. `writeFiles` keeps its whole set
 * resident, so restore streams in batches of about this size: the per-file cap
 * doesn't bound the TOTAL, and a large enough workspace would otherwise buffer
 * entirely and OOM the API pod (256Mi limit).
 */
const RESTORE_BATCH_BYTES = 8 * 1024 * 1024;

/** Retry an idempotent op through transient backend faults, with linear backoff. */
async function withRetry<T>(op: () => Promise<T>, attempts = SANDBOX_WRITE_ATTEMPTS): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await op();
		} catch (err) {
			if (attempt >= attempts) throw err;
			await new Promise((resolve) => {
				setTimeout(resolve, 100 * attempt);
			});
		}
	}
}

/**
 * Split into batches whose listed sizes sum to at most `maxBytes`. A single item
 * over budget gets a batch of its own (never dropped) — the per-file cap is what
 * bounds that case.
 */
function batchByBytes<T extends { size: number }>(items: readonly T[], maxBytes: number): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let bytes = 0;
	for (const item of items) {
		if (batch.length > 0 && bytes + item.size > maxBytes) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(item);
		bytes += item.size;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

async function createSandboxDirectories(
	sandbox: SandboxInstance,
	directories: readonly string[],
): Promise<void> {
	const execute = (command: string) =>
		withRetry(async () => {
			const result = await sandbox.exec(command);
			if (!result.success) throw new Error(`sandbox mkdir failed: ${result.stderr}`);
		});
	const maxCommandLength = 3800;
	let command = 'mkdir -p';
	for (const directory of new Set(directories)) {
		const argument = ` ${shellQuote(directory)}`;
		if (command.length > 'mkdir -p'.length && command.length + argument.length > maxCommandLength) {
			await execute(command);
			command = 'mkdir -p';
		}
		command += argument;
	}
	if (command.length > 'mkdir -p'.length) await execute(command);
}

/** One recursive listing of the working directory, shared by teardown's readers. */
export type WorkspaceListing = () => Promise<ListFilesResult>;

export function sharedWorkspaceListing(
	sandbox: SandboxInstance,
	workingDir: string,
): WorkspaceListing {
	let listing: Promise<ListFilesResult> | undefined;
	return () =>
		(listing ??= Promise.resolve().then(() =>
			sandbox.listFiles(workingDir, { recursive: true, includeHidden: true }),
		));
}

/** `commitSession` owns these; capture never uploads or mirror-deletes them. */
function isRootSourceFile(rel: string, entryNotebook = DEFAULT_LOCAL_ENTRY_NOTEBOOK): boolean {
	return rel === entryNotebook || rel === 'pyproject.toml';
}

// Hooks are executable code; restoring them would run user-supplied scripts on
// the next `git` command if file modes were ever preserved.
function isGitHooksPath(rel: string): boolean {
	const segments = rel.split('/');
	return segments.some((segment, index) => segment === '.git' && segments[index + 1] === 'hooks');
}

function isCaptureExcluded(rel: string, entryNotebook = DEFAULT_LOCAL_ENTRY_NOTEBOOK): boolean {
	return isMirrorProtected(rel, entryNotebook) || isGitHooksPath(rel);
}

/**
 * The files API can store regenerable paths. Capture does not own those copies.
 */
function isMirrorProtected(rel: string, entryNotebook = DEFAULT_LOCAL_ENTRY_NOTEBOOK): boolean {
	return isRootSourceFile(rel, entryNotebook) || isRegenerableArtifactPath(rel);
}

function parentDirectory(rel: string): string {
	return rel.slice(0, Math.max(0, rel.lastIndexOf('/')));
}

/** The repository a path belongs to (`.git`, `pkg/.git`, …), or null outside any `.git`. */
function gitGroupOf(rel: string): string | null {
	const segments = rel.split('/');
	const index = segments.indexOf('.git');
	return index === -1 ? null : segments.slice(0, index + 1).join('/');
}

/**
 * Capture priority under the shared count/byte budget. `.git` is handled
 * separately; the rest must not let marimo caches or dotfiles crowd out data.
 */
function captureTier(rel: string): number {
	const segments = rel.split('/');
	if (segments.includes('__marimo__')) return 1;
	if (segments.some((segment) => segment.startsWith('.'))) return 2;
	return 0;
}

/** What a workspace restore actually moved into the sandbox. */
export interface WorkspaceRestoreStats {
	objectCount: number;
	bytes: number;
}

export interface WorkspaceRestoreOptions {
	requireComplete?: boolean;
	/** Storage reads may precede readiness; sandbox mutations must wait. */
	waitUntilReady?: () => Promise<void>;
	/** Bounds bytes fetched before readiness; over budget, a batch is read after it. */
	prefetchBudget?: ByteBudget;
	/** Relative path roots owned by another restore and therefore skipped. */
	excludeRelativeRoots?: readonly string[];
}

/**
 * Restore a workspace mirror (every key under `sourcePrefix`) from the bucket into
 * the sandbox working directory. Unconditional and binary-safe: every object is
 * read as raw bytes and written back to its file inside `workingDir`, recreating
 * parent directories as needed. `sourcePrefix` is the local notebook's mutable
 * `workspace/` for editable sources, or an immutable `versions/{vid}/workspace/`
 * for synced read-only sources — the restore logic is identical either way.
 *
 * Returns what was copied, so the provisioning wide event can attribute a slow
 * `files` phase to workspace size rather than leaving it to guesswork.
 */
export async function restoreWorkspace(
	sandbox: SandboxInstance,
	bucket: Bucket,
	sourcePrefix: string,
	workingDir: string,
	options: WorkspaceRestoreOptions = {},
): Promise<WorkspaceRestoreStats> {
	// Select from the LISTING (sizes included) so an oversized object is skipped
	// before `bucket.get()` buffers its body — the size check must never use the
	// fetched object.
	const objects = await listAllObjects(bucket, sourcePrefix);
	const wanted: { key: string; dest: string; size: number }[] = [];
	const directories: string[] = [];
	for (const obj of objects) {
		const rel = obj.key.slice(sourcePrefix.length);
		if (!rel) continue;
		const markerDirectory = workspaceDirectoryFromMarkerPath(rel);
		if (markerDirectory !== null) {
			if (!markerDirectory || isGitHooksPath(markerDirectory)) continue;
			if (
				options.excludeRelativeRoots?.some(
					(root) => markerDirectory === root || markerDirectory.startsWith(`${root}/`),
				)
			) {
				continue;
			}
			if (!isSafeWorkspacePath(markerDirectory) || isWorkspaceInternalPath(markerDirectory)) {
				if (options.requireComplete) {
					throw new Error(`restoreWorkspace: unsafe workspace path: ${markerDirectory}`);
				}
				console.warn(`restoreWorkspace: unsafe workspace path; skipping ${markerDirectory}`);
				continue;
			}
			directories.push(`${workingDir}/${markerDirectory}`);
			continue;
		}
		if (
			isGitHooksPath(rel) ||
			options.excludeRelativeRoots?.some((root) => rel === root || rel.startsWith(`${root}/`))
		) {
			continue;
		}
		// A poisoned key (e.g. from a compromised/synced source) whose relative path
		// carries `..`/absolute/backslash segments would escape workingDir once
		// concatenated. Reject or skip it — the sandbox working dir is a hard boundary.
		if (!isSafeWorkspacePath(rel) || isWorkspaceInternalPath(rel)) {
			if (options.requireComplete) {
				throw new Error(`restoreWorkspace: unsafe workspace path: ${rel}`);
			}
			console.warn(`restoreWorkspace: unsafe workspace path; skipping ${rel}`);
			continue;
		}
		if (obj.size > MAX_WORKSPACE_FILE_BYTES) {
			if (options.requireComplete) {
				throw new Error(
					`restoreWorkspace: per-file cap (${MAX_WORKSPACE_FILE_BYTES}) exceeded: ${rel} (${obj.size} bytes)`,
				);
			}
			console.warn(
				`restoreWorkspace: per-file cap (${MAX_WORKSPACE_FILE_BYTES}) exceeded; skipping ${rel} (${obj.size} bytes)`,
			);
			continue;
		}
		wanted.push({ key: obj.key, dest: `${workingDir}/${rel}`, size: obj.size });
	}

	// `writeFiles` creates parent directories (port contract), so the only case
	// still needing an explicit mkdir is an empty workspace — nothing gets written,
	// yet marimo still needs the cwd it runs in to exist.
	if (wanted.length === 0) {
		await options.waitUntilReady?.();
		await createSandboxDirectories(sandbox, directories.length > 0 ? directories : [workingDir]);
		return { objectCount: 0, bytes: 0 };
	}

	// Fetch + write in byte-bounded batches, so only a slice of the workspace is
	// ever resident. Raw bytes go straight to the port — nothing is base64-armored
	// through a shell, and there is no temp file to decode.
	let objectCount = 0;
	let bytes = 0;
	let ready = !options.waitUntilReady;
	for (const batch of batchByBytes(wanted, RESTORE_BATCH_BYTES)) {
		using prefetched =
			ready || !options.prefetchBudget
				? undefined
				: options.prefetchBudget.tryReserve(batch.reduce((sum, f) => sum + f.size, 0));
		if (!ready && options.prefetchBudget && !prefetched) {
			await options.waitUntilReady?.();
			ready = true;
		}
		const fetched = await mapWithConcurrency(batch, RESTORE_FETCH_CONCURRENCY, async (f) => {
			const body = await bucket.get(f.key);
			if (!body) {
				if (options.requireComplete) {
					throw new Error(`restoreWorkspace: listed object is missing: ${f.key}`);
				}
				return;
			}
			return { path: f.dest, content: await body.bytes() };
		});
		const files = fetched.filter((f) => f !== undefined);
		await options.waitUntilReady?.();
		ready = true;
		if (directories.length > 0) {
			await createSandboxDirectories(sandbox, directories);
			directories.length = 0;
		}
		if (files.length > 0) await withRetry(() => sandbox.writeFiles(files));
		objectCount += files.length;
		for (const f of files) bytes += f.content.byteLength;
	}
	return { objectCount, bytes };
}

/** Files under a directory holding a regular `CACHEDIR.TAG`, by presence, not contents. */
function taggedCaches(listed: readonly FileInfo[]) {
	const files = listed.filter(
		({ relativePath }) =>
			isSafeWorkspacePath(relativePath) && !isWorkspaceInternalPath(relativePath),
	);
	const taggedDirectories = new Set<string>();
	for (const file of files) {
		const rel = file.relativePath;
		if (file.type === 'file' && (rel === 'CACHEDIR.TAG' || rel.endsWith('/CACHEDIR.TAG'))) {
			taggedDirectories.add(parentDirectory(rel));
		}
	}
	const isTaggedCache = (rel: string): boolean => {
		if (taggedDirectories.has('')) return true;
		for (let path = rel; path; path = parentDirectory(path)) {
			if (taggedDirectories.has(path)) return true;
		}
		return false;
	};
	const outermost = [...taggedDirectories].filter(
		(directory) => directory === '' || !isTaggedCache(parentDirectory(directory)),
	);
	return { files, isTaggedCache, taggedRoots: taggedDirectories.has('') ? [''] : outermost };
}

/**
 * Save runtime files to `workspace/` on teardown. `commitSession` owns the entry
 * notebook and `pyproject.toml`. Capture preserves stored source files and regenerable caches.
 * A regular `CACHEDIR.TAG` file excludes its directory and descendants from
 * uploads. Detection uses file presence, not contents.
 *
 * `workspace` mode saves visible files first, then `__marimo__/`, then hidden
 * files within the file and byte limits. Each Git directory goes last and must
 * fit as a whole to avoid an incomplete repository. Capture excludes Git hooks.
 * Reads have byte and time limits. Skipped uploads retain their stored copies,
 * except tagged caches: they are regenerable, so their stored copies (including
 * ones captured before tag detection, which restore would otherwise re-tag and
 * pin) are removed like missing files.
 *
 * Cleanup deletes missing files in `workspace` mode and all unprotected runtime
 * files outside tagged caches in `source` mode. A failed listing prevents
 * uploads and cleanup; a thrown listing rejects `workspace` mode only. Pass
 * `listing` to share one listing with `readSessionArtifacts`; `source` mode
 * lists only when a stored key could be deleted.
 */
export async function captureWorkspace(
	sandbox: SandboxInstance,
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
	workingDir: string,
	mode: 'source' | 'workspace',
	listing: WorkspaceListing = sharedWorkspaceListing(sandbox, workingDir),
	entryNotebook = DEFAULT_LOCAL_ENTRY_NOTEBOOK,
): Promise<void> {
	if (!supportsBoundedReads(sandbox)) return;
	const nb = paths.project(projectId).notebook(notebookId);
	const warnListingFailed = (code: string) =>
		console.warn(
			`captureWorkspace: listing ${workingDir} failed (${code}); skipping capture + cleanup`,
		);

	if (mode === 'source') {
		const deletable = (await listAllKeys(bucket, nb.workspacePrefix)).filter((key) => {
			const rel = key.slice(nb.workspacePrefix.length);
			return rel !== '' && !isMirrorProtected(rel, entryNotebook);
		});
		if (deletable.length === 0) return;
		const listed = await listing().catch(() => listFilesFailure('BACKEND_ERROR'));
		if (!listed.success) {
			// A failed listing cannot distinguish deleted files from protected caches.
			warnListingFailed(listed.error.code);
			return;
		}
		const { isTaggedCache } = taggedCaches(listed.files);
		const staleKeys = deletable.filter(
			(key) => !isTaggedCache(key.slice(nb.workspacePrefix.length)),
		);
		if (staleKeys.length > 0) await bucket.delete(staleKeys);
		return;
	}

	const listed = await listing();
	if (!listed.success) {
		warnListingFailed(listed.error.code);
		return;
	}
	const { files, isTaggedCache, taggedRoots } = taggedCaches(listed.files);
	for (const directory of taggedRoots) {
		console.warn(
			directory
				? `captureWorkspace: ${directory.slice(0, 256)} contains CACHEDIR.TAG; skipping it and removing its stored copy`
				: 'captureWorkspace: the workspace root contains CACHEDIR.TAG; skipping every runtime file and removing their stored copies',
		);
	}
	const present = new Set<string>();
	const retainedGitGroups = new Set<string>();

	// Reserve budgets from listed sizes before concurrent reads and uploads.
	const selected: string[] = [];
	const directoryMarkers: string[] = [];
	const candidates: { rel: string; size: number; tier: number }[] = [];
	const gitGroups = new Map<
		string,
		{ files: string[]; directoryMarkers: string[]; bytes: number; fitsPerFileCap: boolean }
	>();
	const gitGroupFor = (group: string) => {
		let entry = gitGroups.get(group);
		if (!entry) {
			entry = { files: [], directoryMarkers: [], bytes: 0, fitsPerFileCap: true };
			gitGroups.set(group, entry);
		}
		return entry;
	};
	for (const file of files) {
		const rel = file.relativePath;
		if (isCaptureExcluded(rel, entryNotebook) || isTaggedCache(rel)) continue;
		const group = gitGroupOf(rel);
		if (file.type === 'directory') {
			(group === null ? directoryMarkers : gitGroupFor(group).directoryMarkers).push(
				workspaceDirectoryMarkerPath(rel),
			);
			continue;
		}
		if (file.type !== 'file') continue;
		present.add(rel);
		if (group !== null) {
			const entry = gitGroupFor(group);
			entry.files.push(rel);
			entry.bytes += file.size;
			if (file.size > MAX_WORKSPACE_FILE_BYTES) entry.fitsPerFileCap = false;
			continue;
		}
		candidates.push({ rel, size: file.size, tier: captureTier(rel) });
	}
	// Stable sort keeps listing order within a tier.
	candidates.sort((left, right) => left.tier - right.tier);

	let totalBytes = 0;
	for (const { rel, size } of candidates) {
		if (selected.length >= MAX_WORKSPACE_FILES) {
			console.warn(
				`captureWorkspace: file count cap (${MAX_WORKSPACE_FILES}) reached; skipping ${rel}`,
			);
			continue;
		}
		if (size > MAX_WORKSPACE_FILE_BYTES) {
			console.warn(
				`captureWorkspace: per-file cap (${MAX_WORKSPACE_FILE_BYTES}) exceeded; skipping ${rel} (${size} bytes)`,
			);
			continue;
		}
		if (totalBytes + size > MAX_WORKSPACE_BYTES) {
			console.warn(
				`captureWorkspace: total-byte cap (${MAX_WORKSPACE_BYTES}) would be exceeded; skipping ${rel} (${size} bytes)`,
			);
			continue;
		}
		selected.push(rel);
		totalBytes += size;
	}

	// Root repository first, then nested ones in listing order.
	const orderedGitGroups = [...gitGroups].sort(
		([left], [right]) => Number(right === '.git') - Number(left === '.git'),
	);
	for (const [group, entry] of orderedGitGroups) {
		if (
			entry.fitsPerFileCap &&
			selected.length + entry.files.length <= MAX_WORKSPACE_FILES &&
			totalBytes + entry.bytes <= MAX_WORKSPACE_BYTES
		) {
			selected.push(...entry.files);
			directoryMarkers.push(...entry.directoryMarkers);
			totalBytes += entry.bytes;
		} else {
			// A stale but complete repository beats a deleted one, so the stored
			// copy is kept whole rather than mirror-deleted.
			retainedGitGroups.add(group);
			console.warn(
				`captureWorkspace: ${group.slice(0, 256)} (${entry.files.length} files, ${entry.bytes} bytes) does not fit the remaining workspace budget; keeping the stored copy`,
			);
		}
	}

	// Presence comes from the listing: skipped uploads retain the last good copy.
	let capturedBytes = 0;
	await mapWithConcurrency(selected, CAPTURE_READ_CONCURRENCY, async (rel) => {
		const result = await readBoundedBytes(
			sandbox,
			`${workingDir}/${rel}`,
			Math.min(MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_BYTES - capturedBytes),
		);
		if (!result?.success || capturedBytes + result.bytes.byteLength > MAX_WORKSPACE_BYTES) {
			console.warn(`captureWorkspace: could not read ${rel.slice(0, 256)}; skipping`);
			return;
		}
		capturedBytes += result.bytes.byteLength;
		await bucket.put(nb.workspaceFile(rel), result.bytes);
	});
	await mapWithConcurrency(directoryMarkers, CAPTURE_FILE_CONCURRENCY, async (marker) =>
		bucket.put(nb.workspaceFile(marker), new Uint8Array()),
	);
	for (const marker of directoryMarkers) present.add(marker);

	const existingKeys = await listAllKeys(bucket, nb.workspacePrefix);
	const staleKeys = existingKeys.filter((key) => {
		const rel = key.slice(nb.workspacePrefix.length);
		if (!rel || isMirrorProtected(rel, entryNotebook)) return false;
		if (isGitHooksPath(rel)) return true;
		const group = gitGroupOf(rel);
		if (group !== null && retainedGitGroups.has(group)) return false;
		return !present.has(rel);
	});
	if (staleKeys.length > 0) {
		await bucket.delete(staleKeys);
	}
}

export async function readSessionArtifacts(
	sandbox: SandboxInstance,
	mountPath: string,
	listing: WorkspaceListing = sharedWorkspaceListing(sandbox, mountPath),
	entryNotebook = DEFAULT_LOCAL_ENTRY_NOTEBOOK,
): Promise<CommitSessionInput> {
	if (!supportsBoundedReads(sandbox)) return {};
	const sizes = await fileSizes(listing);
	const read = (path: string) => readCappedFile(sandbox, path, sizes);
	const separator = entryNotebook.lastIndexOf('/');
	const directory = entryNotebook.slice(0, separator + 1);
	const filename = entryNotebook.slice(separator + 1);
	const artifactRoot = `${mountPath}/${directory}__marimo__`;
	const [code, deps, html, session] = await Promise.all([
		readNotebookCode(sandbox, `${mountPath}/${entryNotebook}`, sizes, entryNotebook),
		read(`${mountPath}/pyproject.toml`),
		read(`${artifactRoot}/${filename.replace(/\.[^.]+$/, '')}.html`),
		read(`${artifactRoot}/session/${filename}.json`),
	]);

	return { code, deps, html, session };
}

async function readNotebookCode(
	sandbox: SandboxInstance,
	absolutePath: string,
	sizes: ReadonlyMap<string, number>,
	entryNotebook: string,
): Promise<string | undefined> {
	const result = await readCappedBytes(sandbox, absolutePath, sizes);
	if (result?.success) return new TextDecoder().decode(result.bytes);
	const code = result?.error.code ?? 'READ_FAILED';
	const error = Object.assign(new Error(`Could not read ${entryNotebook}: ${code}`), {
		code,
		operation: 'sandbox.read_session_artifacts',
		object: entryNotebook,
	});
	if (code !== 'NOT_FOUND') throw error;
	logOperationalError('session_notebook_missing', { operation: error.operation }, error);
	return undefined;
}

/** Listing sizes are an optimization; bounded reads enforce the actual limit. */
export async function listFileSizes(
	sandbox: SandboxInstance,
	mountPath: string,
): Promise<ReadonlyMap<string, number>> {
	return fileSizes(sharedWorkspaceListing(sandbox, mountPath));
}

// Transport limits still apply when listing is unavailable.
async function fileSizes(listing: WorkspaceListing): Promise<ReadonlyMap<string, number>> {
	const sizes = new Map<string, number>();
	const listed = await listing().catch(() => listFilesFailure('BACKEND_ERROR'));
	if (!listed.success) return sizes;
	for (const file of listed.files) {
		sizes.set(file.absolutePath, file.type === 'file' ? file.size : Infinity);
	}
	return sizes;
}

export async function readCappedFile(
	sandbox: SandboxInstance,
	absolutePath: string,
	sizes: ReadonlyMap<string, number>,
): Promise<string | undefined> {
	const result = await readCappedBytes(sandbox, absolutePath, sizes);
	return result?.success ? new TextDecoder().decode(result.bytes) : undefined;
}

type BoundedBytesResult =
	| { success: true; bytes: Uint8Array }
	| Extract<ReadFileResult, { success: false }>;

async function readCappedBytes(
	sandbox: SandboxInstance,
	absolutePath: string,
	sizes: ReadonlyMap<string, number>,
): Promise<BoundedBytesResult | undefined> {
	const size = sizes.get(absolutePath);
	if (size !== undefined && size > MAX_ARTIFACT_BYTES) {
		console.warn(
			`readCappedFile: per-file cap (${MAX_ARTIFACT_BYTES}) exceeded; omitting ${absolutePath} (${size} bytes)`,
		);
		return undefined;
	}
	return readBoundedBytes(sandbox, absolutePath, MAX_ARTIFACT_BYTES);
}

async function readBoundedBytes(
	sandbox: SandboxInstance,
	path: string,
	maxBytes: number,
): Promise<BoundedBytesResult | undefined> {
	if (!supportsBoundedReads(sandbox)) return undefined;
	// External adapters must opt into the bounded contract; never fall back to readFile.
	const result = await sandbox.readFileBounded?.(path, {
		maxBytes,
		timeoutMs: CAPTURE_READ_TIMEOUT_MS,
	});
	if (!result?.success) return result;
	const encodedLimit = result.encoding === 'base64' ? 4 * Math.ceil(maxBytes / 3) : maxBytes;
	if (result.content.length > encodedLimit) return undefined;
	try {
		const bytes =
			result.encoding === 'base64'
				? base64Decode(result.content)
				: new TextEncoder().encode(result.content);
		return bytes.byteLength <= maxBytes ? { success: true, bytes } : undefined;
	} catch {
		return undefined;
	}
}

/** Decode a base64 string to raw bytes without depending on Node's `Buffer`. */
function base64Decode(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
