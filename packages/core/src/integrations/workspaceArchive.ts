import { gunzipSync, unzipSync } from 'fflate';
import { MAX_WORKSPACE_FILE_BYTES } from '../constants';
import { BadRequestError } from '../errors';
import { isSafeWorkspacePath } from './remoteWorkspace';

export interface ArchiveFile {
	path: string;
	bytes: Uint8Array;
}

export interface ParseWorkspaceArchiveOptions {
	/**
	 * Rewrite an entry path before validation, or return `null` to skip the
	 * entry entirely. Lets a caller scope a repository tarball to a root path
	 * (and strip the tarball's top-level directory) while the caps apply to the
	 * selected files only. Skipped entries never count against any limit.
	 */
	mapPath?: (path: string) => string | null;
}

/** Guard against a decompression bomb: cap the inflated tar before we parse it. */
export const MAX_DECOMPRESSED_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 1000;

interface ArchiveLimitState {
	fileCount: number;
	totalBytes: number;
}

const decoder = new TextDecoder();

function assertSafeArchiveFilePath(path: string) {
	if (!isSafeWorkspacePath(path)) {
		throw new BadRequestError(`Unsafe archive path: ${path}`);
	}
}

function assertSafeArchiveDirectoryPath(path: string) {
	const normalized = path.replace(/\/+$/, '');
	if (!isSafeWorkspacePath(normalized)) {
		throw new BadRequestError(`Unsafe archive path: ${path}`);
	}
}

function enforceArchiveFileLimits(state: ArchiveLimitState, path: string, size: number): void {
	state.fileCount += 1;
	if (state.fileCount > MAX_ARCHIVE_FILES) {
		throw new BadRequestError(`Archive exceeds the ${MAX_ARCHIVE_FILES}-file limit`);
	}
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WORKSPACE_FILE_BYTES) {
		throw new BadRequestError(
			`Archive file exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit: ${path}`,
		);
	}
	state.totalBytes += size;
	if (state.totalBytes > MAX_DECOMPRESSED_ARCHIVE_BYTES) {
		throw new BadRequestError('Decompressed archive exceeds the size limit');
	}
}

function addFile(files: Map<string, Uint8Array>, path: string, bytes: Uint8Array) {
	assertSafeArchiveFilePath(path);
	if (files.has(path)) {
		throw new BadRequestError(`Duplicate archive path: ${path}`);
	}
	files.set(path, bytes);
}

function toArchiveFiles(files: Map<string, Uint8Array>): ArchiveFile[] {
	return [...files.entries()].map(([path, bytes]) => ({ path, bytes }));
}

function parseZip(bytes: Uint8Array, mapPath: (path: string) => string | null): ArchiveFile[] {
	const paths = new Set<string>();
	const limits: ArchiveLimitState = { fileCount: 0, totalBytes: 0 };
	try {
		// Read the central directory without inflating anything. fflate sizes each
		// output allocation from this metadata, so rejecting the complete archive in
		// this pass prevents a late entry from exceeding the budget after earlier
		// entries have already consumed memory.
		unzipSync(bytes, {
			filter: ({ name, originalSize }) => {
				if (name.endsWith('/')) {
					assertSafeArchiveDirectoryPath(name);
					return false;
				}
				const mapped = mapPath(name);
				if (mapped === null) return false;
				assertSafeArchiveFilePath(mapped);
				if (paths.has(mapped)) throw new BadRequestError(`Duplicate archive path: ${mapped}`);
				paths.add(mapped);
				enforceArchiveFileLimits(limits, mapped, originalSize);
				return false;
			},
		});
	} catch (error) {
		if (error instanceof BadRequestError) throw error;
		throw new BadRequestError('Invalid zip archive');
	}

	let unzipped: Record<string, Uint8Array>;
	try {
		unzipped = unzipSync(bytes, {
			filter: ({ name }) => !name.endsWith('/') && mapPath(name) !== null,
		});
	} catch {
		throw new BadRequestError('Invalid zip archive');
	}
	const files = new Map<string, Uint8Array>();
	for (const [path, body] of Object.entries(unzipped)) {
		const mapped = mapPath(path);
		if (mapped === null) continue;
		addFile(files, mapped, body);
	}
	return toArchiveFiles(files);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function tarString(bytes: Uint8Array, start: number, length: number): string {
	const slice = bytes.subarray(start, start + length);
	const nul = slice.indexOf(0);
	return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function tarSize(bytes: Uint8Array, offset: number): number {
	const raw = tarString(bytes, offset + 124, 12).trim();
	if (raw && !/^[0-7]+$/.test(raw)) {
		throw new BadRequestError('Invalid tar entry size');
	}
	const size = raw ? Number.parseInt(raw, 8) : 0;
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new BadRequestError('Invalid tar entry size');
	}
	return size;
}

/** Decode a NUL-terminated tar field (GNU long name/linkname payload). */
function decodeCString(data: Uint8Array): string {
	const nul = data.indexOf(0);
	return decoder.decode(nul === -1 ? data : data.subarray(0, nul));
}

/**
 * Parse a pax extended-header payload into its records. Each record is
 * `"<len> key=value\n"` where `<len>` is the decimal byte length of the whole
 * record. We only consume `path`; everything else (mtime, comment, …) is ignored.
 */
function parsePaxRecords(data: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	let i = 0;
	while (i < data.length) {
		let j = i;
		while (j < data.length && data[j] !== 0x20) j++;
		const len = Number.parseInt(decoder.decode(data.subarray(i, j)), 10);
		if (!Number.isSafeInteger(len) || len <= 0 || i + len > data.length) break;
		const body = decoder.decode(data.subarray(j + 1, i + len - 1));
		const eq = body.indexOf('=');
		if (eq !== -1) records.set(body.slice(0, eq), body.slice(eq + 1));
		i += len;
	}
	return records;
}

const TAR_BLOCK_BYTES = 512;
/** Caps a pax / GNU-longname payload; real path metadata is a few KB at most. */
const MAX_TAR_METADATA_BYTES = 1024 * 1024;

interface TarEntryState {
	kind: 'file' | 'meta' | 'skip';
	/** Mapped workspace path for `file` entries; the raw header path otherwise. */
	path: string;
	typeFlag: string;
	chunks: Uint8Array[];
	dataRemaining: number;
	paddingRemaining: number;
}

/**
 * Incremental tar-stream scanner. Handles POSIX ustar plus the extensions
 * real-world producers emit — `git archive` and GitHub codeload write a pax global
 * header, and any long path arrives via a pax `x` record or a GNU `L` entry. Each
 * such header carries the path for the *following* entry. Non-regular entries
 * (symlinks, devices, fifos) are skipped rather than rejected so a normal repo
 * tree still syncs.
 *
 * Feed decompressed bytes with `push` in any chunking; entries `mapPath` skips
 * are discarded as they stream, so the archive caps — and memory — cover only
 * the selected files. This is what lets a small configured subtree sync from a
 * repository whose full archive would exceed the ingest limits.
 */
export class WorkspaceTarCollector {
	private readonly mapPath: (path: string) => string | null;
	private readonly files = new Map<string, Uint8Array>();
	private readonly limits: ArchiveLimitState = { fileCount: 0, totalBytes: 0 };
	/** Partial header block carried across `push` boundaries. */
	private stash: Uint8Array = new Uint8Array(0);
	private entry: TarEntryState | null = null;
	private pathOverride: string | undefined;
	private done = false;

	constructor(options: ParseWorkspaceArchiveOptions = {}) {
		this.mapPath = options.mapPath ?? ((path: string) => path);
	}

	push(input: Uint8Array): void {
		let chunk = input;
		while (chunk.length > 0 && !this.done) {
			if (this.entry) {
				chunk = this.consumeEntryBytes(this.entry, chunk);
				continue;
			}
			if (this.stash.length + chunk.length < TAR_BLOCK_BYTES) {
				// Copies both parts, detaching the stash from the caller's buffer.
				this.stash = concatBytes([this.stash, chunk]);
				return;
			}
			const needed = TAR_BLOCK_BYTES - this.stash.length;
			const block =
				this.stash.length > 0
					? concatBytes([this.stash, chunk.subarray(0, needed)])
					: chunk.subarray(0, needed);
			this.stash = new Uint8Array(0);
			chunk = chunk.subarray(needed);
			this.startEntry(block);
		}
	}

	finish(): ArchiveFile[] {
		// Mirrors the whole-buffer semantics: entry data must be complete, while a
		// missing final padding block or trailing partial block is tolerated.
		if (this.entry) {
			if (this.entry.dataRemaining > 0) {
				throw new BadRequestError(`Truncated tar entry: ${this.entry.path}`);
			}
			this.completeEntry(this.entry);
			this.entry = null;
		}
		return toArchiveFiles(this.files);
	}

	/**
	 * Whether the archive's end-of-archive marker (a zero block) was seen.
	 * Streaming callers should require this: gzip inflation reports no error for
	 * a connection cut at an entry boundary, and only the marker distinguishes a
	 * complete archive from a truncated one.
	 */
	get sawEndOfArchive(): boolean {
		return this.done;
	}

	private startEntry(block: Uint8Array): void {
		if (block.every((b) => b === 0)) {
			this.done = true;
			return;
		}
		const name = tarString(block, 0, 100);
		const prefix = tarString(block, 345, 155);
		const headerPath = prefix ? `${prefix}/${name}` : name;
		const size = tarSize(block, 0);
		const typeFlag = String.fromCharCode(block[156] || 0);
		const base = {
			path: headerPath,
			typeFlag,
			chunks: [] as Uint8Array[],
			dataRemaining: size,
			paddingRemaining: (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
		};

		// Metadata headers describe the *next* entry; they leave any pending
		// override in place (a pax `path` / GNU long name sets it; pax global `g`
		// and GNU long-link `K` carry data we don't use).
		if (typeFlag === 'x' || typeFlag === 'L') {
			if (size > MAX_TAR_METADATA_BYTES) {
				throw new BadRequestError('Tar metadata entry exceeds the size limit');
			}
			this.entry = { ...base, kind: 'meta' };
		} else if (typeFlag === 'g' || typeFlag === 'K') {
			this.entry = { ...base, kind: 'skip' };
		} else {
			const path = this.pathOverride ?? headerPath;
			this.pathOverride = undefined;
			if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') {
				const mapped = this.mapPath(path);
				if (mapped === null) {
					this.entry = { ...base, kind: 'skip' };
				} else {
					enforceArchiveFileLimits(this.limits, mapped, size);
					assertSafeArchiveFilePath(mapped);
					if (this.files.has(mapped)) {
						throw new BadRequestError(`Duplicate archive path: ${mapped}`);
					}
					this.entry = { ...base, kind: 'file', path: mapped };
				}
			} else {
				if (typeFlag === '5') assertSafeArchiveDirectoryPath(path);
				this.entry = { ...base, kind: 'skip' };
			}
		}
		if (this.entry.dataRemaining === 0 && this.entry.paddingRemaining === 0) {
			this.completeEntry(this.entry);
			this.entry = null;
		}
	}

	private consumeEntryBytes(entry: TarEntryState, chunk: Uint8Array): Uint8Array {
		let rest = chunk;
		if (entry.dataRemaining > 0) {
			const take = Math.min(entry.dataRemaining, rest.length);
			if (entry.kind !== 'skip') entry.chunks.push(rest.slice(0, take));
			entry.dataRemaining -= take;
			rest = rest.subarray(take);
		}
		if (entry.dataRemaining === 0 && entry.paddingRemaining > 0 && rest.length > 0) {
			const take = Math.min(entry.paddingRemaining, rest.length);
			entry.paddingRemaining -= take;
			rest = rest.subarray(take);
		}
		if (entry.dataRemaining === 0 && entry.paddingRemaining === 0) {
			this.completeEntry(entry);
			this.entry = null;
		}
		return rest;
	}

	private completeEntry(entry: TarEntryState): void {
		if (entry.kind === 'file') {
			this.files.set(entry.path, concatBytes(entry.chunks));
		} else if (entry.kind === 'meta') {
			const payload = concatBytes(entry.chunks);
			if (entry.typeFlag === 'x') {
				const path = parsePaxRecords(payload).get('path');
				if (path !== undefined) this.pathOverride = path;
			} else {
				this.pathOverride = decodeCString(payload);
			}
		}
	}
}

function parseTar(bytes: Uint8Array, mapPath: (path: string) => string | null): ArchiveFile[] {
	const collector = new WorkspaceTarCollector({ mapPath });
	collector.push(bytes);
	return collector.finish();
}

function isGzip(bytes: Uint8Array, format: string | undefined): boolean {
	if (format) return ['gz', 'gzip', 'tgz', 'tar.gz'].includes(format);
	return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function gunzip(bytes: Uint8Array): Uint8Array {
	// The gzip ISIZE trailer (uncompressed size mod 2^32, little-endian) is a cheap
	// pre-check against a decompression bomb before we allocate the inflated output.
	if (bytes.length >= 4) {
		const isize =
			(bytes[bytes.length - 4] |
				(bytes[bytes.length - 3] << 8) |
				(bytes[bytes.length - 2] << 16) |
				(bytes[bytes.length - 1] << 24)) >>>
			0;
		if (isize > MAX_DECOMPRESSED_ARCHIVE_BYTES) {
			throw new BadRequestError('Decompressed archive exceeds the size limit');
		}
	}
	let out: Uint8Array;
	try {
		out = gunzipSync(bytes);
	} catch {
		throw new BadRequestError('Invalid gzip archive');
	}
	if (out.length > MAX_DECOMPRESSED_ARCHIVE_BYTES) {
		throw new BadRequestError('Decompressed archive exceeds the size limit');
	}
	return out;
}

function parseUncompressed(
	bytes: Uint8Array,
	format: string | undefined,
	contentType: string | undefined,
	mapPath: (path: string) => string | null,
): ArchiveFile[] {
	if (format === 'zip' || (!format && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
		return parseZip(bytes, mapPath);
	}
	// gzip formats never reach here — `parseWorkspaceArchive` decompresses first and
	// re-dispatches with format `tar`.
	if (
		format === 'tar' ||
		(!format && contentType?.toLowerCase().includes('tar')) ||
		tarString(bytes, 257, 5) === 'ustar'
	) {
		return parseTar(bytes, mapPath);
	}
	throw new BadRequestError('Unsupported archive format; send zip, tar, or tar.gz');
}

export function parseWorkspaceArchive(
	bytes: Uint8Array,
	format: string | undefined,
	contentType: string | undefined,
	options: ParseWorkspaceArchiveOptions = {},
): ArchiveFile[] {
	const mapPath = options.mapPath ?? ((path: string) => path);
	const lowerFormat = format?.toLowerCase();
	if (isGzip(bytes, lowerFormat)) {
		// gzip on this endpoint is always a `.tar.gz` — decompress, then parse as tar.
		return parseUncompressed(gunzip(bytes), 'tar', contentType, mapPath);
	}
	return parseUncompressed(bytes, lowerFormat, contentType, mapPath);
}
