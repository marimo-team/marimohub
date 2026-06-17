import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import type { NotebookId, ProjectId } from '../../ids';
import { paths } from '../../paths';
import type { SandboxInstance } from '../../ports/sandbox';
import { MAX_ARTIFACT_BYTES, MAX_WORKSPACE_FILE_BYTES } from '../../constants';
import { shellQuote } from './shell';
import { listAllKeys, listAllObjects } from '../catalog/storage';
import type { CommitSessionInput } from '../content/NotebookService';

/**
 * Max concurrent per-file transfers to/from the sandbox. Each file is a few
 * round-trips (read/write + exec); bounded parallelism hides that latency
 * without flooding the sandbox's command channel.
 */
const SANDBOX_FILE_CONCURRENCY = 8;

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

/** Cap on the total bytes captured into `workspace/` per teardown. */
const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024;
/** Cap on the number of files captured into `workspace/` per teardown. */
const MAX_WORKSPACE_FILES = 1000;

/** True when a workspace-relative path is a source/snapshot/junk path we never capture/delete. */
function isExcluded(rel: string): boolean {
	const segments = rel.split('/');
	return WORKSPACE_EXCLUDE.some((ex) =>
		// Directory entries (`foo/`) match a `foo` segment at any depth (e.g. nested
		// `pkg/__pycache__/x.pyc`); bare entries are exact root-level files.
		ex.endsWith('/') ? segments.includes(ex.slice(0, -1)) : rel === ex,
	);
}

/**
 * Restore a workspace mirror (every key under `sourcePrefix`) from the bucket into
 * the sandbox working directory. Unconditional and binary-safe: every object is
 * read as raw bytes and written back to its file inside `workingDir`, recreating
 * parent directories as needed. `sourcePrefix` is the local notebook's mutable
 * `workspace/` for editable sources, or an immutable `versions/{vid}/workspace/`
 * for synced read-only sources — the restore logic is identical either way.
 */
export async function restoreWorkspace(
	sandbox: SandboxInstance,
	bucket: Bucket,
	sourcePrefix: string,
	workingDir: string,
): Promise<void> {
	await sandbox.exec(`mkdir -p ${shellQuote(workingDir)}`);

	// List with sizes so an oversized object is skipped *before* `bucket.get()` —
	// adapters buffer the whole body inside `get()`, so the size check must use
	// the listing's `size`, never the fetched object. Files are independent, so
	// restore them with bounded parallelism rather than one round-trip at a time.
	const objects = await listAllObjects(bucket, sourcePrefix);
	await mapWithConcurrency(objects, SANDBOX_FILE_CONCURRENCY, async ({ key, size }) => {
		const rel = key.slice(sourcePrefix.length);
		if (!rel) return;
		if (size > MAX_WORKSPACE_FILE_BYTES) {
			console.warn(
				`restoreWorkspace: per-file cap (${MAX_WORKSPACE_FILE_BYTES}) exceeded; skipping ${rel} (${size} bytes)`,
			);
			return;
		}
		const obj = await bucket.get(key);
		if (!obj) return;
		const bytes = await obj.bytes();
		const b64 = base64Encode(bytes);
		const dest = `${workingDir}/${rel}`;
		const destDir = dest.slice(0, dest.lastIndexOf('/')) || workingDir;
		// Pass the payload via writeFile (stdin in every adapter), not a shell arg,
		// which would overflow ARG_MAX for any sizeable file. mkdir first: SDK-backed
		// writeFile (E2B, CoreWeave, Modal) does not create missing parents.
		// Concurrent `mkdir -p` on a shared parent is safe (idempotent); the tmp name
		// is per-dest so parallel writers never collide.
		const tmp = `${dest}.b64.tmp`;
		await sandbox.exec(`mkdir -p ${shellQuote(destDir)}`);
		await sandbox.writeFile(tmp, b64);
		await sandbox.exec(
			`base64 -d ${shellQuote(tmp)} > ${shellQuote(dest)} && rm -f ${shellQuote(tmp)}`,
		);
	});
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

	// Relative paths currently present in the sandbox working dir (files only,
	// excluding source + snapshots). Used both to upload (workspace mode) and to
	// drive mirror-deletes (both modes).
	const present = new Set<string>();

	if (mode === 'workspace') {
		const listing = await sandbox.listFiles(workingDir, { recursive: true });
		if (!listing.success) {
			// Could not enumerate the working dir — bail out entirely. Falling through
			// to the mirror-delete below with an empty `present` set would treat every
			// captured key as stale and delete it, wiping still-present workspace data
			// on a transient listing failure.
			console.warn(`captureWorkspace: listing ${workingDir} failed; skipping capture + cleanup`);
			return;
		}
		// Select the files to capture first — sequentially, since the count/byte caps
		// are cumulative and order-dependent. Selection is pure size arithmetic from
		// the listing (no I/O), so it's cheap; the actual reads+uploads run in
		// parallel below. Uses each file's listed size for the caps (≈ the bytes we'll
		// upload), so the decision never waits on a read.
		const selected: string[] = [];
		let totalBytes = 0;
		for (const file of listing.files) {
			if (file.type !== 'file') continue;
			const rel = file.relativePath;
			if (isExcluded(rel)) continue;

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
		const captured = await mapWithConcurrency(selected, SANDBOX_FILE_CONCURRENCY, async (rel) => {
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
	// Stat once so an oversized artifact (notably marimo's rendered HTML) is
	// omitted *before* `readFile` buffers it into a string. Sizes are keyed by
	// absolute path; an artifact absent from the listing falls through to readFile
	// (size undefined), preserving the omit-when-unreadable contract. Stat is
	// best-effort — a listing failure must never block teardown's save-on-reap
	// commit, so we fall back to reading without the cap.
	const sizes = new Map<string, number>();
	try {
		const listing = await sandbox.listFiles(mountPath, { recursive: true, includeHidden: true });
		if (listing.success) {
			for (const file of listing.files) {
				if (file.type === 'file') sizes.set(file.absolutePath, file.size);
			}
		}
	} catch {
		// Listing unsupported/failed: proceed without size info; the per-file read
		// below still runs (the cap simply isn't applied for this teardown).
	}

	const read = async (path: string): Promise<string | undefined> => {
		const size = sizes.get(path);
		if (size !== undefined && size > MAX_ARTIFACT_BYTES) {
			console.warn(
				`readSessionArtifacts: per-file cap (${MAX_ARTIFACT_BYTES}) exceeded; omitting ${path} (${size} bytes)`,
			);
			return undefined;
		}
		const result = await sandbox.readFile(path);
		return result.success ? result.content : undefined;
	};

	const [code, deps, html, session] = await Promise.all([
		read(`${mountPath}/notebook.py`),
		read(`${mountPath}/pyproject.toml`),
		read(`${mountPath}/__marimo__/notebook.html`),
		read(`${mountPath}/__marimo__/session/notebook.py.json`),
	]);

	return { code, deps, html, session };
}

/** Base64-encode raw bytes without depending on Node's `Buffer` (Workers-safe). */
function base64Encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
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
