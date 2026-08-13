import { gunzipSync, unzipSync } from 'fflate';
import { BadRequestError, isSafeWorkspacePath, MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core';

export interface ArchiveFile {
	path: string;
	bytes: Uint8Array;
}

/** Guard against a decompression bomb: cap the inflated tar before we parse it. */
const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;
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
	if (state.totalBytes > MAX_DECOMPRESSED_BYTES) {
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

function parseZip(bytes: Uint8Array): ArchiveFile[] {
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
				assertSafeArchiveFilePath(name);
				if (paths.has(name)) throw new BadRequestError(`Duplicate archive path: ${name}`);
				paths.add(name);
				enforceArchiveFileLimits(limits, name, originalSize);
				return false;
			},
		});
	} catch (error) {
		if (error instanceof BadRequestError) throw error;
		throw new BadRequestError('Invalid zip archive');
	}

	let unzipped: Record<string, Uint8Array>;
	try {
		unzipped = unzipSync(bytes, { filter: ({ name }) => !name.endsWith('/') });
	} catch {
		throw new BadRequestError('Invalid zip archive');
	}
	const files = new Map<string, Uint8Array>();
	for (const [path, body] of Object.entries(unzipped)) {
		addFile(files, path, body);
	}
	return toArchiveFiles(files);
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

/**
 * Parse an (uncompressed) tar stream. Handles POSIX ustar plus the extensions
 * real-world producers emit — `git archive` and GitHub codeload write a pax global
 * header, and any long path arrives via a pax `x` record or a GNU `L` entry. Each
 * such header carries the path for the *following* entry. Non-regular entries
 * (symlinks, devices, fifos) are skipped rather than rejected so a normal repo
 * tree still syncs.
 */
function parseTar(bytes: Uint8Array): ArchiveFile[] {
	const files = new Map<string, Uint8Array>();
	let offset = 0;
	let pathOverride: string | undefined;
	const limits: ArchiveLimitState = { fileCount: 0, totalBytes: 0 };
	while (offset + 512 <= bytes.length) {
		const block = bytes.subarray(offset, offset + 512);
		if (block.every((b) => b === 0)) break;

		const name = tarString(bytes, offset, 100);
		const prefix = tarString(bytes, offset + 345, 155);
		const headerPath = prefix ? `${prefix}/${name}` : name;
		const size = tarSize(bytes, offset);
		const typeFlag = String.fromCharCode(bytes[offset + 156] || 0);
		const dataOffset = offset + 512;
		if (dataOffset + size > bytes.length) {
			throw new BadRequestError(`Truncated tar entry: ${headerPath}`);
		}
		const data = bytes.subarray(dataOffset, dataOffset + size);
		const next = () => {
			offset = dataOffset + Math.ceil(size / 512) * 512;
		};

		// Metadata headers that describe the *next* entry; they leave any pending
		// override in place (a pax `path` / GNU long name sets it; pax global `g` and
		// GNU long-link `K` carry data we don't use).
		if (typeFlag === 'x') {
			const path = parsePaxRecords(data).get('path');
			if (path !== undefined) pathOverride = path;
			next();
			continue;
		}
		if (typeFlag === 'L') {
			pathOverride = decodeCString(data);
			next();
			continue;
		}
		if (typeFlag === 'g' || typeFlag === 'K') {
			next();
			continue;
		}

		const path = pathOverride ?? headerPath;
		pathOverride = undefined;

		if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') {
			enforceArchiveFileLimits(limits, path, size);
			addFile(files, path, bytes.slice(dataOffset, dataOffset + size));
		} else if (typeFlag === '5') {
			assertSafeArchiveDirectoryPath(path);
		}
		next();
	}
	return toArchiveFiles(files);
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
		if (isize > MAX_DECOMPRESSED_BYTES) {
			throw new BadRequestError('Decompressed archive exceeds the size limit');
		}
	}
	let out: Uint8Array;
	try {
		out = gunzipSync(bytes);
	} catch {
		throw new BadRequestError('Invalid gzip archive');
	}
	if (out.length > MAX_DECOMPRESSED_BYTES) {
		throw new BadRequestError('Decompressed archive exceeds the size limit');
	}
	return out;
}

function parseUncompressed(
	bytes: Uint8Array,
	format: string | undefined,
	contentType: string | undefined,
): ArchiveFile[] {
	if (format === 'zip' || (!format && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
		return parseZip(bytes);
	}
	// gzip formats never reach here — `parseWorkspaceArchive` decompresses first and
	// re-dispatches with format `tar`.
	if (
		format === 'tar' ||
		(!format && contentType?.toLowerCase().includes('tar')) ||
		tarString(bytes, 257, 5) === 'ustar'
	) {
		return parseTar(bytes);
	}
	throw new BadRequestError('Unsupported archive format; send zip, tar, or tar.gz');
}

export function parseWorkspaceArchive(
	bytes: Uint8Array,
	format: string | undefined,
	contentType: string | undefined,
): ArchiveFile[] {
	const lowerFormat = format?.toLowerCase();
	if (isGzip(bytes, lowerFormat)) {
		// gzip on this endpoint is always a `.tar.gz` — decompress, then parse as tar.
		return parseUncompressed(gunzip(bytes), 'tar', contentType);
	}
	return parseUncompressed(bytes, lowerFormat, contentType);
}
