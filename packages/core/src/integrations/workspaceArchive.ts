import { Gunzip, Inflate, strFromU8 } from 'fflate';
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

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const INFLATE_INPUT_CHUNK_BYTES = 1024;

interface ZipEntry {
	mapped: string;
	compression: number;
	crc32: number;
	compressedSize: number;
	originalSize: number;
	dataOffset: number;
}

function findZipEnd(view: DataView): number {
	const minimum = Math.max(0, view.byteLength - 65_557);
	for (let offset = view.byteLength - 22; offset >= minimum; offset--) {
		if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue;
		const commentLength = view.getUint16(offset + 20, true);
		if (offset + 22 + commentLength === view.byteLength) return offset;
	}
	throw new BadRequestError('Invalid zip archive');
}

function zipEntries(bytes: Uint8Array, mapPath: (path: string) => string | null): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const endOffset = findZipEnd(view);
	const disk = view.getUint16(endOffset + 4, true);
	const centralDisk = view.getUint16(endOffset + 6, true);
	const entriesOnDisk = view.getUint16(endOffset + 8, true);
	const entryCount = view.getUint16(endOffset + 10, true);
	const centralSize = view.getUint32(endOffset + 12, true);
	const centralOffset = view.getUint32(endOffset + 16, true);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		entriesOnDisk !== entryCount ||
		entryCount === 0xffff ||
		centralSize === 0xffffffff ||
		centralOffset === 0xffffffff ||
		centralOffset + centralSize > endOffset
	) {
		throw new BadRequestError('Invalid zip archive');
	}

	const paths = new Set<string>();
	const limits: ArchiveLimitState = { fileCount: 0, totalBytes: 0 };
	const entries: ZipEntry[] = [];
	let offset = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > centralOffset + centralSize) {
			throw new BadRequestError('Invalid zip archive');
		}
		if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
			throw new BadRequestError('Invalid zip archive');
		}
		const flags = view.getUint16(offset + 8, true);
		const compression = view.getUint16(offset + 10, true);
		const crc32 = view.getUint32(offset + 16, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const originalSize = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localDisk = view.getUint16(offset + 34, true);
		const localOffset = view.getUint32(offset + 42, true);
		const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
		if (
			nextOffset > centralOffset + centralSize ||
			localDisk !== 0 ||
			compressedSize === 0xffffffff ||
			originalSize === 0xffffffff ||
			localOffset === 0xffffffff
		) {
			throw new BadRequestError('Invalid zip archive');
		}
		const name = strFromU8(
			bytes.subarray(offset + 46, offset + 46 + nameLength),
			(flags & 0x0800) === 0,
		);
		offset = nextOffset;
		if (name.endsWith('/')) {
			assertSafeArchiveDirectoryPath(name);
			continue;
		}
		const mapped = mapPath(name);
		if (mapped === null) continue;
		assertSafeArchiveFilePath(mapped);
		if (paths.has(mapped)) throw new BadRequestError(`Duplicate archive path: ${mapped}`);
		paths.add(mapped);
		enforceArchiveFileLimits(limits, mapped, originalSize);
		if ((flags & ZIP_FLAG_ENCRYPTED) !== 0 || (compression !== 0 && compression !== 8)) {
			throw new BadRequestError('Invalid zip archive');
		}

		if (
			localOffset + 30 > centralOffset ||
			view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
		) {
			throw new BadRequestError('Invalid zip archive');
		}
		const localFlags = view.getUint16(localOffset + 6, true);
		const localCompression = view.getUint16(localOffset + 8, true);
		const localNameLength = view.getUint16(localOffset + 26, true);
		const localExtraLength = view.getUint16(localOffset + 28, true);
		const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
		const localName = strFromU8(
			bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
			(localFlags & 0x0800) === 0,
		);
		if (
			dataOffset + compressedSize > centralOffset ||
			localFlags !== flags ||
			localCompression !== compression ||
			localName !== name
		) {
			throw new BadRequestError('Invalid zip archive');
		}
		if (
			(flags & ZIP_FLAG_DATA_DESCRIPTOR) === 0 &&
			(view.getUint32(localOffset + 14, true) !== crc32 ||
				view.getUint32(localOffset + 18, true) !== compressedSize ||
				view.getUint32(localOffset + 22, true) !== originalSize)
		) {
			throw new BadRequestError('Invalid zip archive');
		}
		entries.push({
			mapped,
			compression,
			crc32,
			compressedSize,
			originalSize,
			dataOffset,
		});
	}
	if (offset !== centralOffset + centralSize) throw new BadRequestError('Invalid zip archive');
	return entries;
}

const crcTable = new Uint32Array(256).map((_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	return value >>> 0;
});

function updateCrc32(state: number, bytes: Uint8Array): number {
	let next = state;
	for (const byte of bytes) next = crcTable[(next ^ byte) & 0xff] ^ (next >>> 8);
	return next >>> 0;
}

function pushCompressedChunks(
	bytes: Uint8Array,
	push: (chunk: Uint8Array, final: boolean) => void,
): void {
	if (bytes.length === 0) {
		push(bytes, true);
		return;
	}
	for (let offset = 0; offset < bytes.length; offset += INFLATE_INPUT_CHUNK_BYTES) {
		const end = Math.min(bytes.length, offset + INFLATE_INPUT_CHUNK_BYTES);
		push(bytes.subarray(offset, end), end === bytes.length);
	}
}

function inflateZipEntry(
	archive: Uint8Array,
	entry: ZipEntry,
	actual: ArchiveLimitState,
): Uint8Array {
	actual.fileCount += 1;
	if (actual.fileCount > MAX_ARCHIVE_FILES) {
		throw new BadRequestError(`Archive exceeds the ${MAX_ARCHIVE_FILES}-file limit`);
	}
	let size = 0;
	let crc = 0xffffffff;
	let finished = entry.compression === 0;
	const chunks: Uint8Array[] = [];
	const accept = (chunk: Uint8Array) => {
		if (chunk.length === 0) return;
		size += chunk.length;
		if (size > MAX_WORKSPACE_FILE_BYTES) {
			throw new BadRequestError(
				`Archive file exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit: ${entry.mapped}`,
			);
		}
		actual.totalBytes += chunk.length;
		if (actual.totalBytes > MAX_DECOMPRESSED_ARCHIVE_BYTES) {
			throw new BadRequestError('Decompressed archive exceeds the size limit');
		}
		crc = updateCrc32(crc, chunk);
		chunks.push(new Uint8Array(chunk));
	};
	const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
	if (entry.compression === 0) {
		accept(compressed);
	} else {
		const inflater = new Inflate((chunk, final) => {
			accept(chunk);
			finished = final;
		});
		pushCompressedChunks(compressed, (chunk, final) => inflater.push(chunk, final));
	}
	if (!finished || size !== entry.originalSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc32) {
		throw new BadRequestError('Invalid zip archive');
	}
	return concatBytes(chunks);
}

function parseZip(bytes: Uint8Array, mapPath: (path: string) => string | null): ArchiveFile[] {
	try {
		const entries = zipEntries(bytes, mapPath);
		const actual: ArchiveLimitState = { fileCount: 0, totalBytes: 0 };
		const files = new Map<string, Uint8Array>();
		for (const entry of entries)
			addFile(files, entry.mapped, inflateZipEntry(bytes, entry, actual));
		return toArchiveFiles(files);
	} catch (error) {
		if (error instanceof BadRequestError) throw error;
		throw new BadRequestError('Invalid zip archive');
	}
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
		if (this.entry && this.entry.dataRemaining > 0) {
			throw new BadRequestError(`Truncated tar entry: ${this.entry.path}`);
		}
		// The end-of-archive marker (a zero block) is required: neither an upload
		// nor gzip inflation reports anything for input cut cleanly at an entry
		// boundary (or inside a padding block), and only the marker distinguishes
		// a complete archive from a silently partial one. Every real producer —
		// tar, bsdtar, `git archive`, GitHub codeload — writes it.
		if (!this.done) {
			throw new BadRequestError('Truncated tar archive: missing end-of-archive marker');
		}
		return toArchiveFiles(this.files);
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

function parseGzipTar(bytes: Uint8Array, mapPath: (path: string) => string | null): ArchiveFile[] {
	if (bytes.length < 18) throw new BadRequestError('Invalid gzip archive');
	const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 8, 8);
	const expectedCrc = trailer.getUint32(0, true);
	const expectedSize = trailer.getUint32(4, true);
	const collector = new WorkspaceTarCollector({ mapPath });
	let crc = 0xffffffff;
	let size = 0;
	let finished = false;
	let memberCount = 1;
	try {
		const inflater = new Gunzip((chunk, final) => {
			size += chunk.length;
			if (size > MAX_DECOMPRESSED_ARCHIVE_BYTES) {
				throw new BadRequestError('Decompressed archive exceeds the size limit');
			}
			crc = updateCrc32(crc, chunk);
			collector.push(chunk);
			finished = final;
		});
		inflater.onmember = () => {
			memberCount += 1;
			throw new BadRequestError('Multi-member gzip archives are not supported');
		};
		pushCompressedChunks(bytes, (chunk, final) => inflater.push(chunk, final));
	} catch (error) {
		if (error instanceof BadRequestError) throw error;
		throw new BadRequestError('Invalid gzip archive');
	}
	if (
		!finished ||
		memberCount !== 1 ||
		size >>> 0 !== expectedSize ||
		(crc ^ 0xffffffff) >>> 0 !== expectedCrc
	) {
		throw new BadRequestError('Invalid gzip archive');
	}
	return collector.finish();
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
		return parseGzipTar(bytes, mapPath);
	}
	return parseUncompressed(bytes, lowerFormat, contentType, mapPath);
}
