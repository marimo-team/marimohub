import { describe, expect, it } from 'vitest';
import { gzipSync, zipSync } from 'fflate';
import { MAX_WORKSPACE_FILE_BYTES } from '../constants';
import { BadRequestError } from '../errors';
import { parseWorkspaceArchive, WorkspaceTarCollector } from './workspaceArchive';

const encode = (s: string) => new TextEncoder().encode(s);

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

function setZipOriginalSizes(archive: Uint8Array, sizes: number[]): Uint8Array {
	const patched = new Uint8Array(archive);
	const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
	let entry = 0;
	for (let offset = 0; offset <= patched.length - 4; offset += 1) {
		if (view.getUint32(offset, true) !== 0x02014b50) continue;
		if (entry >= sizes.length)
			throw new Error('ZIP has more central-directory entries than expected');
		view.setUint32(offset + 24, sizes[entry], true);
		entry += 1;
	}
	if (entry !== sizes.length)
		throw new Error('ZIP has fewer central-directory entries than expected');
	return patched;
}

/** A single 512-byte tar header with the given name, body size, and typeflag. */
function tarHeader(name: string, size: number, typeFlag: string): Uint8Array {
	const header = new Uint8Array(512);
	header.set(encode(name).subarray(0, 100), 0);
	header.set(encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
	header[156] = typeFlag.charCodeAt(0);
	return header;
}

/** A header + its body, NUL-padded to the next 512-byte boundary. */
function tarEntry(name: string, body: Uint8Array, typeFlag: string): Uint8Array {
	const padding = (512 - (body.length % 512)) % 512;
	return concat([tarHeader(name, body.length, typeFlag), body, new Uint8Array(padding)]);
}

const TAR_TRAILER = new Uint8Array(1024);

/** A pax record `"<len> key=value\n"`, where `<len>` counts its own digits too. */
function paxRecord(key: string, value: string): Uint8Array {
	const content = `${key}=${value}\n`;
	let digits = 1;
	for (;;) {
		const total = digits + 1 + content.length;
		if (String(total).length === digits) return encode(`${total} ${content}`);
		digits = String(total).length;
	}
}

function tarArchive(
	files: Record<string, string> | [string, string][],
	options: { truncate?: boolean } = {},
): Uint8Array {
	const chunks: Uint8Array[] = [];
	const entries = Array.isArray(files) ? files : Object.entries(files);
	for (const [path, value] of entries) {
		const body = encode(value);
		const header = new Uint8Array(512);
		header.set(encode(path), 0);
		header.set(encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
		header[156] = '0'.charCodeAt(0);
		chunks.push(header, body);
		const padding = (512 - (body.length % 512)) % 512;
		if (padding > 0) chunks.push(new Uint8Array(padding));
	}
	chunks.push(new Uint8Array(1024));
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const truncatedLength = entries.length > 0 ? 512 + encode(entries[0][1]).length - 1 : total - 1;
	const out = new Uint8Array(options.truncate ? truncatedLength : total);
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= out.length) break;
		out.set(chunk.slice(0, Math.min(chunk.length, out.length - offset)), offset);
		offset += chunk.length;
	}
	return out;
}

describe('parseWorkspaceArchive', () => {
	it('parses zip and tar files into workspace file entries', () => {
		const zipFiles = parseWorkspaceArchive(
			zipSync({ 'app.py': encode('print(1)') }),
			'zip',
			'application/zip',
		);
		expect(zipFiles.map((f) => f.path)).toEqual(['app.py']);
		expect(new TextDecoder().decode(zipFiles[0].bytes)).toBe('print(1)');

		const tarFiles = parseWorkspaceArchive(tarArchive({ 'app.py': 'print(2)' }), 'tar', '');
		expect(tarFiles.map((f) => f.path)).toEqual(['app.py']);
		expect(new TextDecoder().decode(tarFiles[0].bytes)).toBe('print(2)');
	});

	it('rejects unsafe paths for files and directory entries', () => {
		expect(() =>
			parseWorkspaceArchive(zipSync({ '../app.py': encode('print(1)') }), 'zip', ''),
		).toThrow(BadRequestError);

		expect(() => parseWorkspaceArchive(zipSync({ '../': new Uint8Array() }), 'zip', '')).toThrow(
			BadRequestError,
		);
	});

	it('rejects zip files and aggregate output beyond the decompressed byte limits', () => {
		const oneFile = zipSync({ 'large.bin': new Uint8Array() });
		expect(() =>
			parseWorkspaceArchive(
				setZipOriginalSizes(oneFile, [MAX_WORKSPACE_FILE_BYTES + 1]),
				'zip',
				'',
			),
		).toThrow(/Archive file exceeds/);

		const fiveFiles = zipSync(
			Object.fromEntries(
				Array.from({ length: 5 }, (_, index) => [`${index}.bin`, new Uint8Array()]),
			),
		);
		expect(() =>
			parseWorkspaceArchive(
				setZipOriginalSizes(fiveFiles, [
					MAX_WORKSPACE_FILE_BYTES,
					MAX_WORKSPACE_FILE_BYTES,
					MAX_WORKSPACE_FILE_BYTES,
					MAX_WORKSPACE_FILE_BYTES,
					1,
				]),
				'zip',
				'',
			),
		).toThrow(/Decompressed archive exceeds/);
	});

	it('rejects zip archives with more than 1000 files', () => {
		const archive = zipSync(
			Object.fromEntries(
				Array.from({ length: 1001 }, (_, index) => [`${index}.txt`, new Uint8Array()]),
			),
		);
		expect(() => parseWorkspaceArchive(archive, 'zip', '')).toThrow(/1000-file limit/);
	});

	it('applies the file-count and per-file limits to tar archives', () => {
		const tooMany = concat([
			...Array.from({ length: 1001 }, (_, index) =>
				tarEntry(`${index}.txt`, new Uint8Array(), '0'),
			),
			TAR_TRAILER,
		]);
		expect(() => parseWorkspaceArchive(tooMany, 'tar', '')).toThrow(/1000-file limit/);

		const oversized = concat([
			tarHeader('large.bin', MAX_WORKSPACE_FILE_BYTES + 1, '0'),
			new Uint8Array(MAX_WORKSPACE_FILE_BYTES + 1),
			TAR_TRAILER,
		]);
		expect(() => parseWorkspaceArchive(oversized, 'tar', '')).toThrow(/Archive file exceeds/);
	});

	it('parses a gzipped tar (.tar.gz)', () => {
		const tar = tarArchive({ 'app.py': 'print("gz")' });
		const files = parseWorkspaceArchive(gzipSync(tar), 'tar.gz', 'application/gzip');
		expect(files.map((f) => f.path)).toEqual(['app.py']);
		expect(new TextDecoder().decode(files[0].bytes)).toBe('print("gz")');

		// Also detected from gzip magic bytes alone, with no format hint.
		const sniffed = parseWorkspaceArchive(gzipSync(tar), undefined, undefined);
		expect(sniffed.map((f) => f.path)).toEqual(['app.py']);
	});

	it('skips a pax global header (as git archive / GitHub codeload emit)', () => {
		const archive = concat([
			tarEntry(
				'pax_global_header',
				encode('52 comment=0000000000000000000000000000000000000000\n'),
				'g',
			),
			tarEntry('app.py', encode('print("pax")'), '0'),
			TAR_TRAILER,
		]);
		const files = parseWorkspaceArchive(archive, 'tar', '');
		expect(files.map((f) => f.path)).toEqual(['app.py']);
		expect(new TextDecoder().decode(files[0].bytes)).toBe('print("pax")');
	});

	it('resolves a long path from a pax extended header', () => {
		const longPath = `deeply/nested/${'x'.repeat(150)}.py`;
		const archive = concat([
			tarEntry('x', paxRecord('path', longPath), 'x'),
			tarEntry('short.py', encode('print("long")'), '0'),
			TAR_TRAILER,
		]);
		const files = parseWorkspaceArchive(archive, 'tar', '');
		expect(files.map((f) => f.path)).toEqual([longPath]);
	});

	it('resolves a long path from a GNU longname entry', () => {
		const longPath = `pkg/${'y'.repeat(120)}.py`;
		const archive = concat([
			tarEntry('././@LongLink', encode(`${longPath}\0`), 'L'),
			tarEntry('truncated', encode('print("gnu")'), '0'),
			TAR_TRAILER,
		]);
		const files = parseWorkspaceArchive(archive, 'tar', '');
		expect(files.map((f) => f.path)).toEqual([longPath]);
	});

	it('skips symlink entries rather than rejecting the whole archive', () => {
		const archive = concat([
			tarEntry('link', encode(''), '2'),
			tarEntry('app.py', encode('print("ok")'), '0'),
			TAR_TRAILER,
		]);
		const files = parseWorkspaceArchive(archive, 'tar', '');
		expect(files.map((f) => f.path)).toEqual(['app.py']);
	});

	it('rejects a gzip member whose declared size exceeds the cap', () => {
		const tar = tarArchive({ 'app.py': 'print(1)' });
		const gz = gzipSync(tar);
		// Forge the ISIZE trailer (last 4 bytes, little-endian) to claim ~4 GiB.
		gz[gz.length - 1] = 0xff;
		gz[gz.length - 2] = 0xff;
		gz[gz.length - 3] = 0xff;
		gz[gz.length - 4] = 0xff;
		expect(() => parseWorkspaceArchive(gz, 'tar.gz', '')).toThrow(BadRequestError);
	});

	it('rejects duplicate file paths and truncated tar entries', () => {
		expect(() =>
			parseWorkspaceArchive(
				tarArchive([
					['app.py', 'a'],
					['app.py', 'b'],
				]),
				'tar',
				'',
			),
		).toThrow(BadRequestError);

		expect(() =>
			parseWorkspaceArchive(tarArchive({ 'app.py': 'print(1)' }, { truncate: true }), 'tar', ''),
		).toThrow(BadRequestError);
	});

	it('rewrites and filters entries through mapPath, in tar and zip alike', () => {
		const mapPath = (path: string) =>
			path.startsWith('root/apps/') ? path.slice('root/apps/'.length) : null;

		const tarFiles = parseWorkspaceArchive(
			tarArchive({
				'root/README.md': 'skip',
				'root/apps/nb.py': 'print(1)',
				'root/apps/sub/util.py': 'print(2)',
			}),
			'tar',
			'',
			{ mapPath },
		);
		expect(tarFiles.map((f) => f.path).sort()).toEqual(['nb.py', 'sub/util.py']);

		const zipFiles = parseWorkspaceArchive(
			zipSync({
				'root/README.md': encode('skip'),
				'root/apps/nb.py': encode('print(1)'),
			}),
			'zip',
			'',
			{ mapPath },
		);
		expect(zipFiles.map((f) => f.path)).toEqual(['nb.py']);
	});

	it('applies the file-count limit to mapped entries only', () => {
		const entries: [string, string][] = Array.from({ length: 1001 }, (_, i) => [
			`skip/${i}.txt`,
			'x',
		]);
		entries.push(['keep/app.py', 'print(1)']);
		const files = parseWorkspaceArchive(tarArchive(entries), 'tar', '', {
			mapPath: (path) => (path.startsWith('keep/') ? path.slice('keep/'.length) : null),
		});
		expect(files.map((f) => f.path)).toEqual(['app.py']);
	});

	it('collects identical output regardless of push chunking', () => {
		const archive = tarArchive({ 'a.py': 'print(1)', 'dir/b.txt': 'bb', 'dir/c.txt': 'cc' });
		const collector = new WorkspaceTarCollector();
		for (let offset = 0; offset < archive.length; offset += 7) {
			collector.push(archive.subarray(offset, offset + 7));
		}
		expect(collector.finish()).toEqual(parseWorkspaceArchive(archive, 'tar', ''));
	});

	it('rejects a tar that ends cleanly but without the end-of-archive marker', () => {
		// A complete entry with no trailer — an upload cut at an entry boundary
		// is indistinguishable from a complete archive without this check.
		const collector = new WorkspaceTarCollector();
		collector.push(tarEntry('a.py', encode('print(1)'), '0'));
		expect(() => collector.finish()).toThrow(/missing end-of-archive marker/);

		expect(() =>
			parseWorkspaceArchive(tarEntry('a.py', encode('print(1)'), '0'), 'tar', ''),
		).toThrow(/missing end-of-archive marker/);
	});

	it('rejects an oversized pax metadata entry before buffering it', () => {
		const collector = new WorkspaceTarCollector();
		expect(() => collector.push(tarHeader('big-pax', 2 * 1024 * 1024, 'x'))).toThrow(
			/metadata entry exceeds/,
		);
	});

	it('rejects mapped paths that collide or are unsafe', () => {
		expect(() =>
			parseWorkspaceArchive(
				tarArchive([
					['a/app.py', 'a'],
					['b/app.py', 'b'],
				]),
				'tar',
				'',
				{ mapPath: (path) => path.slice(path.indexOf('/') + 1) },
			),
		).toThrow(/Duplicate archive path/);

		expect(() =>
			parseWorkspaceArchive(tarArchive({ 'app.py': 'a' }), 'tar', '', {
				mapPath: () => '../evil.py',
			}),
		).toThrow(/Unsafe archive path/);
	});
});
