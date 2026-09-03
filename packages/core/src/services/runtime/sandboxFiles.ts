import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import type { SandboxInstance } from '../../ports/sandbox';
import {
	MAX_ARTIFACT_BYTES,
	MAX_WORKSPACE_BYTES,
	MAX_WORKSPACE_FILE_BYTES,
	MAX_WORKSPACE_FILES,
} from '../../constants';
import { shellQuote } from './shell';
import {
	isSafeWorkspacePath,
	isWorkspaceInternalPath,
	workspaceDirectoryFromMarkerPath,
	workspaceDirectoryMarkerPath,
} from '../../integrations/remoteWorkspace';
import { listAllKeys, listAllObjects } from '../catalog/storage';
import type { CommitSessionInput } from '../content/NotebookService';

/**
 * Restore GETs touch only the object store and byte-bounded API memory, so they
 * can fan out further than capture reads, which contend on the sandbox command
 * channel.
 */
const RESTORE_FETCH_CONCURRENCY = 32;
const CAPTURE_FILE_CONCURRENCY = 8;

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

/**
 * Workspace-relative paths the capture/restore path leaves alone. Entries ending
 * in `/` are directory names matched at any depth; the rest are exact root files.
 * `notebook.py` / `pyproject.toml` are the source files — owned by
 * `NotebookService.commitSession`, which writes them into `workspace/` and into
 * the immutable `versions/{vid}/` record. `__marimo__/` holds marimo's rendered
 * HTML / session snapshots, which are versioned separately. `.venv/` and
 * `__pycache__/` are regenerable Python build/env artifacts (uv resolves the venv
 * beside the notebook) — large, churny, and pointless to persist. Everything else
 * under the working dir is "the workspace."
 */
const WORKSPACE_EXCLUDE = [
	'notebook.py',
	'pyproject.toml',
	'__marimo__/',
	'.venv/',
	'__pycache__/',
];

/** True when a workspace-relative path is a source/snapshot/junk path we never capture/delete. */
function isExcluded(rel: string): boolean {
	const segments = rel.split('/');
	return WORKSPACE_EXCLUDE.some((ex) =>
		// Directory entries (`foo/`) match a `foo` segment at any depth (e.g. nested
		// `pkg/__pycache__/x.pyc`); bare entries are exact root-level files.
		ex.endsWith('/') ? segments.includes(ex.slice(0, -1)) : rel === ex,
	);
}

/** What a workspace restore actually moved into the sandbox. */
export interface WorkspaceRestoreStats {
	objectCount: number;
	bytes: number;
}

export interface WorkspaceRestoreOptions {
	requireComplete?: boolean;
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
			if (!markerDirectory) continue;
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
		if (options.excludeRelativeRoots?.some((root) => rel === root || rel.startsWith(`${root}/`))) {
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
	if (directories.length > 0) await createSandboxDirectories(sandbox, directories);
	if (wanted.length === 0) {
		if (directories.length === 0) {
			await createSandboxDirectories(sandbox, [workingDir]);
		}
		return { objectCount: 0, bytes: 0 };
	}

	// Fetch + write in byte-bounded batches, so only a slice of the workspace is
	// ever resident. Raw bytes go straight to the port — nothing is base64-armored
	// through a shell, and there is no temp file to decode.
	let objectCount = 0;
	let bytes = 0;
	for (const batch of batchByBytes(wanted, RESTORE_BATCH_BYTES)) {
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
		if (files.length > 0) await withRetry(() => sandbox.writeFiles(files));
		objectCount += files.length;
		for (const f of files) bytes += f.content.byteLength;
	}
	return { objectCount, bytes };
}

/**
 * Capture the notebook's `workspace/` folder from the sandbox working directory
 * back into the bucket on teardown. Source files (`notebook.py`,
 * `pyproject.toml`) and `__marimo__/` snapshots are excluded — they are owned by
 * `NotebookService.commitSession` — so this captures only the runtime workspace.
 *
 * In `workspace` mode every remaining file is read binary-safely (via
 * `base64 -w0`) and written to its `workspace/` key. In `source` mode no runtime
 * files are uploaded. Both modes then mirror-delete: any key under `workspace/`
 * (other than the excluded source files) that is no longer present in the sandbox
 * is removed, keeping `workspace/` an accurate latest-only mirror and cleaning up
 * stale data if a notebook is downgraded from `workspace` to `source`.
 *
 * Caps bound a runaway upload (total bytes + file count); each skipped file is
 * logged via `console.warn` rather than silently dropped.
 */
export async function captureWorkspace(
	sandbox: SandboxInstance,
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
	workingDir: string,
	mode: 'source' | 'workspace',
): Promise<void> {
	const nb = paths.project(projectId).notebook(notebookId);

	// Relative paths currently present in the sandbox working dir, excluding source
	// files and snapshots. Used to upload files and drive mirror-deletes.
	const present = new Set<string>();

	if (mode === 'workspace') {
		const listing = await sandbox.listFiles(workingDir, { recursive: true });
		if (!listing.success) {
			// Could not enumerate the working dir — bail out entirely. Falling through
			// to the mirror-delete below with an empty `present` set would treat every
			// captured key as stale and delete it, wiping still-present workspace data
			// on a transient listing failure.
			console.warn(
				`captureWorkspace: listing ${workingDir} failed (${listing.error.code}); skipping capture + cleanup`,
			);
			return;
		}
		// Select the files to capture first — sequentially, since the count/byte caps
		// are cumulative and order-dependent. Selection is pure size arithmetic from
		// the listing (no I/O), so it's cheap; the actual reads+uploads run in
		// parallel below. Uses each file's listed size for the caps (≈ the bytes we'll
		// upload), so the decision never waits on a read.
		const selected: string[] = [];
		const directoryMarkers: string[] = [];
		let totalBytes = 0;
		for (const file of listing.files) {
			const rel = file.relativePath;
			if (!isSafeWorkspacePath(rel) || isWorkspaceInternalPath(rel) || isExcluded(rel)) {
				continue;
			}
			if (file.type === 'directory') {
				directoryMarkers.push(workspaceDirectoryMarkerPath(rel));
				continue;
			}
			if (file.type !== 'file') continue;

			if (selected.length >= MAX_WORKSPACE_FILES) {
				console.warn(
					`captureWorkspace: file count cap (${MAX_WORKSPACE_FILES}) reached; skipping ${rel}`,
				);
				continue;
			}
			if (file.size > MAX_WORKSPACE_FILE_BYTES) {
				console.warn(
					`captureWorkspace: per-file cap (${MAX_WORKSPACE_FILE_BYTES}) exceeded; skipping ${rel} (${file.size} bytes)`,
				);
				continue;
			}
			if (totalBytes + file.size > MAX_WORKSPACE_BYTES) {
				console.warn(
					`captureWorkspace: total-byte cap (${MAX_WORKSPACE_BYTES}) would be exceeded; skipping ${rel} (${file.size} bytes)`,
				);
				continue;
			}
			selected.push(rel);
			totalBytes += file.size;
		}

		// A read failure skips just that file (logged); successful ones join the
		// `present` mirror set that drives the delete pass below.
		const captured = await mapWithConcurrency(selected, CAPTURE_FILE_CONCURRENCY, async (rel) => {
			const result = await sandbox.exec(`base64 -w0 ${shellQuote(`${workingDir}/${rel}`)}`);
			if (!result.success) {
				console.warn(`captureWorkspace: could not read ${rel}; skipping`);
				return;
			}
			const bytes = base64Decode(result.stdout.trim());
			await bucket.put(nb.workspaceFile(rel), bytes);
			return rel;
		});
		for (const rel of captured) {
			if (rel) present.add(rel);
		}
		await mapWithConcurrency(directoryMarkers, CAPTURE_FILE_CONCURRENCY, async (marker) =>
			bucket.put(nb.workspaceFile(marker), new Uint8Array()),
		);
		for (const marker of directoryMarkers) present.add(marker);
	}

	// Mirror-delete: drop any captured key no longer present in the sandbox. Never
	// touch the source files — commitSession owns those.
	const existingKeys = await listAllKeys(bucket, nb.workspacePrefix);
	const staleKeys = existingKeys.filter((key) => {
		const rel = key.slice(nb.workspacePrefix.length);
		if (!rel || isExcluded(rel)) return false;
		return !present.has(rel);
	});
	if (staleKeys.length > 0) {
		await bucket.delete(staleKeys);
	}
}

/**
 * Read a session's final artifacts back from the sandbox workspace on teardown:
 * the notebook code/deps plus marimo's optional `__marimo__/notebook.html` and
 * `__marimo__/session/notebook.py.json`. Every field is omitted when its file is
 * absent or unreadable. The result is handed to `NotebookService.commitSession`,
 * which cuts a version and attaches the snapshots.
 *
 * The session file is keyed by the notebook filename, which is always
 * `notebook.py` in the sandbox (see `SandboxProvisioner.provision`), so the path
 * is deterministic.
 */
export async function readSessionArtifacts(
	sandbox: SandboxInstance,
	mountPath: string,
): Promise<CommitSessionInput> {
	const sizes = await listFileSizes(sandbox, mountPath);
	const read = (path: string) => readCappedFile(sandbox, path, sizes);
	const [code, deps, html, session] = await Promise.all([
		read(`${mountPath}/notebook.py`),
		read(`${mountPath}/pyproject.toml`),
		read(`${mountPath}/__marimo__/notebook.html`),
		read(`${mountPath}/__marimo__/session/notebook.py.json`),
	]);

	return { code, deps, html, session };
}

/**
 * Sizes of every file under `mountPath`, keyed by absolute path, so an
 * oversized artifact can be refused BEFORE `readFile` buffers it. Best-effort:
 * a listing failure yields an empty map and the reads below run uncapped —
 * a teardown's save-on-reap commit must never be blocked by a stat.
 */
export async function listFileSizes(
	sandbox: SandboxInstance,
	mountPath: string,
): Promise<ReadonlyMap<string, number>> {
	const sizes = new Map<string, number>();
	try {
		const listing = await sandbox.listFiles(mountPath, { recursive: true, includeHidden: true });
		if (listing.success) {
			for (const file of listing.files) {
				if (file.type === 'file') sizes.set(file.absolutePath, file.size);
			}
		}
	} catch {
		// Listing unsupported/failed: the caller reads without the cap.
	}
	return sizes;
}

/**
 * Read one sandbox file as text, or `undefined` when it is absent, unreadable,
 * or listed above `MAX_ARTIFACT_BYTES` (an artifact absent from `sizes` falls
 * through to the read, preserving the omit-when-unreadable contract).
 */
export async function readCappedFile(
	sandbox: SandboxInstance,
	absolutePath: string,
	sizes: ReadonlyMap<string, number>,
): Promise<string | undefined> {
	const size = sizes.get(absolutePath);
	if (size !== undefined && size > MAX_ARTIFACT_BYTES) {
		console.warn(
			`readCappedFile: per-file cap (${MAX_ARTIFACT_BYTES}) exceeded; omitting ${absolutePath} (${size} bytes)`,
		);
		return undefined;
	}
	const result = await sandbox.readFile(absolutePath);
	return result.success ? result.content : undefined;
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
