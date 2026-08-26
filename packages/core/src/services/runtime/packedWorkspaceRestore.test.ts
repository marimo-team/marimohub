import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackedWorkspaceArchive } from '../../integrations/packedWorkspace';
import type { BucketObjectBody } from '../../ports/bucket';
import { makeFakeSandbox, MemoryBucket } from '../../testing';
import { EXTRACT_PACKED_WORKSPACE, restorePackedWorkspace } from './packedWorkspaceRestore';

const encode = (value: string) => new TextEncoder().encode(value);
const temporaryDirectories: string[] = [];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TRANSPORT_BYTES = 256 * 1024 * 1024;

function patchZip(
	archive: Uint8Array,
	patch: (view: DataView, offset: number) => void,
): Uint8Array {
	const result = new Uint8Array(archive);
	const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
	for (let offset = 0; offset <= result.length - 4; offset++) patch(view, offset);
	return result;
}

function setZipFlags(archive: Uint8Array, flags: number): Uint8Array {
	return patchZip(archive, (view, offset) => {
		const signature = view.getUint32(offset, true);
		if (signature === 0x04034b50) view.setUint16(offset + 6, flags, true);
		if (signature === 0x02014b50) view.setUint16(offset + 8, flags, true);
	});
}

function corruptZipCrc(archive: Uint8Array): Uint8Array {
	return patchZip(archive, (view, offset) => {
		const signature = view.getUint32(offset, true);
		if (signature === 0x04034b50) view.setUint32(offset + 14, 0, true);
		if (signature === 0x02014b50) view.setUint32(offset + 16, 0, true);
	});
}

function setCentralSizes(archive: Uint8Array, sizes: number[]): Uint8Array {
	let index = 0;
	const result = patchZip(archive, (view, offset) => {
		if (view.getUint32(offset, true) !== 0x02014b50) return;
		if (index >= sizes.length) throw new Error('ZIP has more entries than expected');
		view.setUint32(offset + 24, sizes[index], true);
		index++;
	});
	if (index !== sizes.length) throw new Error('ZIP has fewer entries than expected');
	return result;
}

function renameZipEntry(archive: Uint8Array, from: string, to: string): Uint8Array {
	if (from.length !== to.length) throw new Error('ZIP entry replacements must have equal lengths');
	const result = new Uint8Array(archive);
	const source = encode(from);
	const replacement = encode(to);
	for (let offset = 0; offset <= result.length - source.length; offset++) {
		if (source.every((byte, index) => result[offset + index] === byte)) {
			result.set(replacement, offset);
		}
	}
	return result;
}

function bucketObject(bytes: Uint8Array, size = bytes.byteLength): BucketObjectBody {
	return {
		key: 'workspace.zip',
		etag: 'etag-1',
		size,
		uploaded: new Date(0),
		text: async () => '',
		json: async <T>() => ({}) as T,
		bytes: async () => bytes,
	};
}

function runExtractor(archive: Uint8Array, requireGit: boolean, readOnlyParent = false) {
	const root = mkdtempSync(join(tmpdir(), 'marimohub-packed-'));
	temporaryDirectories.push(root);
	const destination = join(root, 'workspace');
	const temporaryRoot = join(destination, '.marimohub-packed-restore');
	const script = join(temporaryRoot, 'extract.py');
	const archivePath = join(temporaryRoot, 'workspace.zip');
	mkdirSync(temporaryRoot, { recursive: true });
	writeFileSync(script, EXTRACT_PACKED_WORKSPACE);
	writeFileSync(archivePath, archive);
	if (readOnlyParent) chmodSync(root, 0o555);
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync('python3', [
			script,
			archivePath,
			temporaryRoot,
			destination,
			requireGit ? '1' : '0',
		]);
	} finally {
		if (readOnlyParent) chmodSync(root, 0o755);
	}
	return {
		root,
		destination,
		result,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('packed workspace extractor', () => {
	it('restores binary workspace files and required Git metadata', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([
				['app.py', encode('print(1)')],
				['data/blob.bin', new Uint8Array([0, 255, 1])],
				['分析/empty.txt', new Uint8Array()],
			]),
			git: new Map([['HEAD', encode('ref: refs/heads/main\n')]]),
		});
		const { destination, result } = runExtractor(archive, true, true);

		expect(result.status, result.stderr.toString()).toBe(0);
		expect(readFileSync(join(destination, 'app.py'), 'utf8')).toBe('print(1)');
		expect(readFileSync(join(destination, 'data/blob.bin'))).toEqual(Buffer.from([0, 255, 1]));
		expect(readFileSync(join(destination, '分析/empty.txt'))).toHaveLength(0);
		expect(readFileSync(join(destination, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
	});

	it('rejects traversal paths before replacing an existing destination', () => {
		const root = mkdtempSync(join(tmpdir(), 'marimohub-packed-'));
		temporaryDirectories.push(root);
		const destination = join(root, 'workspace');
		const temporaryRoot = join(destination, '.marimohub-packed-restore');
		const archivePath = join(temporaryRoot, 'workspace.zip');
		const scriptPath = join(temporaryRoot, 'extract.py');
		mkdirSync(temporaryRoot, { recursive: true });
		writeFileSync(join(destination, 'keep.txt'), 'keep');
		writeFileSync(scriptPath, EXTRACT_PACKED_WORKSPACE);
		writeFileSync(archivePath, zipSync({ '../escape.txt': encode('bad') }));

		const result = spawnSync('python3', [scriptPath, archivePath, temporaryRoot, destination, '0']);

		expect(result.status).toBe(1);
		expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
	});

	it('refuses to merge into a non-empty workspace', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
		});
		const root = mkdtempSync(join(tmpdir(), 'marimohub-packed-'));
		temporaryDirectories.push(root);
		const destination = join(root, 'workspace');
		const temporaryRoot = join(destination, '.marimohub-packed-restore');
		const script = join(temporaryRoot, 'extract.py');
		const archivePath = join(temporaryRoot, 'workspace.zip');
		mkdirSync(temporaryRoot, { recursive: true });
		writeFileSync(join(destination, 'keep.txt'), 'keep');
		writeFileSync(script, EXTRACT_PACKED_WORKSPACE);
		writeFileSync(archivePath, archive);

		const result = spawnSync('python3', [script, archivePath, temporaryRoot, destination, '0']);

		expect(result.status).toBe(1);
		expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
		expect(() => readFileSync(join(destination, 'app.py'))).toThrow();
	});

	it('rejects symlinks, FIFOs, and incomplete pull-mode Git metadata', () => {
		for (const attrs of [0o120777 * 65536, 0o010644 * 65536]) {
			const special = zipSync({ link: [encode('target'), { os: 3, attrs }] });
			expect(runExtractor(special, false).result.status).toBe(1);
		}

		const withoutHead = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
			git: new Map([['config', encode('config')]]),
		});
		expect(runExtractor(withoutHead, true).result.status).toBe(1);
	});

	it.each([
		{ label: 'S_IFREG with 0o644 permissions', mode: 0o100644 },
		{ label: 'permission-only 0o644', mode: 0o000644 },
	])('restores a regular file encoded as $label', ({ mode }) => {
		const archive = zipSync({ 'app.py': [encode('print(1)'), { os: 3, attrs: mode * 65536 }] });
		const { destination, result } = runExtractor(archive, false);

		expect(result.status, result.stderr.toString()).toBe(0);
		expect(readFileSync(join(destination, 'app.py'), 'utf8')).toBe('print(1)');
	});

	it('rejects a truncated archive', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
		});
		expect(runExtractor(archive.subarray(0, archive.byteLength - 10), false).result.status).toBe(1);
	});

	it('rejects empty, directory-bearing, encrypted, duplicate, and CRC-invalid archives', () => {
		const empty = zipSync({});
		const directory = zipSync({ 'data/': new Uint8Array() });
		const encrypted = setZipFlags(zipSync({ 'app.py': encode('print(1)') }), 1);
		const duplicate = renameZipEntry(
			zipSync({ 'one.py': encode('first'), 'two.py': encode('second') }),
			'two.py',
			'one.py',
		);
		const badCrc = corruptZipCrc(zipSync({ 'app.py': encode('not empty') }));
		const absolute = zipSync({ '/app.py': encode('bad') });
		const backslash = zipSync({ 'dir\\app.py': encode('bad') });
		const emptySegment = zipSync({ 'dir//app.py': encode('bad') });

		for (const archive of [
			empty,
			directory,
			encrypted,
			duplicate,
			badCrc,
			absolute,
			backslash,
			emptySegment,
		]) {
			expect(runExtractor(archive, false).result.status).toBe(1);
		}
	});

	it('rejects declared per-file and aggregate workspace limits before extraction', () => {
		const perFile = setCentralSizes(zipSync({ 'large.bin': new Uint8Array() }), [
			MAX_FILE_BYTES + 1,
		]);
		const aggregate = setCentralSizes(
			zipSync(
				Object.fromEntries(
					Array.from({ length: 5 }, (_, index) => [`${index}.bin`, new Uint8Array()]),
				),
			),
			[MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, 1],
		);

		expect(runExtractor(perFile, false).result.status).toBe(1);
		expect(runExtractor(aggregate, false).result.status).toBe(1);
	});

	it('enforces Git aggregate and file-count limits separately from workspace limits', () => {
		const aggregate = setCentralSizes(
			zipSync({
				'.git/HEAD': new Uint8Array(),
				'.git/objects/1': new Uint8Array(),
				'.git/objects/2': new Uint8Array(),
				'.git/objects/3': new Uint8Array(),
				'.git/objects/4': new Uint8Array(),
			}),
			[MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES, 1],
		);
		const tooMany = zipSync({
			'.git/HEAD': new Uint8Array(),
			...Object.fromEntries(
				Array.from({ length: 1000 }, (_, index) => [`.git/objects/${index}`, new Uint8Array()]),
			),
		});

		expect(runExtractor(aggregate, true).result.status).toBe(1);
		expect(runExtractor(tooMany, true).result.status).toBe(1);
	});

	it('rejects more than 1000 workspace files', () => {
		const archive = zipSync(
			Object.fromEntries(
				Array.from({ length: 1001 }, (_, index) => [`${index}.txt`, new Uint8Array()]),
			),
		);

		expect(runExtractor(archive, false).result.status).toBe(1);
	});

	it('rejects an archive path reserved for restore files', () => {
		const archive = zipSync({
			'.marimohub-packed-restore/payload': encode('conflict'),
		});
		expect(runExtractor(archive, false).result.status).toBe(1);
	});
});

describe('restorePackedWorkspace', () => {
	it('returns missing without creating temporary sandbox files', async () => {
		const { instance, calls } = makeFakeSandbox();
		const result = await restorePackedWorkspace(
			instance,
			new MemoryBucket(),
			'workspace.zip',
			'/workspace',
			false,
		);

		expect(result).toEqual({ status: 'missing' });
		expect(calls.writeFiles).toHaveLength(0);
		expect(calls.exec).toHaveLength(0);
	});

	it('rejects unsafe working directories before fetching the archive', async () => {
		for (const workingDir of [
			'workspace',
			'/',
			'//',
			'/workspace//nested',
			'/workspace/../other',
			'/workspace\\other',
		]) {
			const { instance } = makeFakeSandbox();
			const bucket = new MemoryBucket();
			const get = vi.spyOn(bucket, 'get');

			const result = await restorePackedWorkspace(
				instance,
				bucket,
				'workspace.zip',
				workingDir,
				false,
			);

			expect(result.status).toBe('failed');
			expect(get).not.toHaveBeenCalled();
		}
	});

	it('rejects an oversized object without reading or writing its body', async () => {
		const { instance, calls } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		const bytes = vi.fn(async () => new Uint8Array());
		const object = bucketObject(new Uint8Array(), MAX_TRANSPORT_BYTES + 1);
		object.bytes = bytes;
		vi.spyOn(bucket, 'get').mockResolvedValue(object);

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
		);

		expect(result.status).toBe('failed');
		expect(bytes).not.toHaveBeenCalled();
		expect(calls.writeFiles).toHaveLength(0);
		expect(calls.exec.some((command) => command.startsWith('rm -rf -- '))).toBe(true);
	});

	it('rejects a body whose byte length differs from object metadata', async () => {
		const { instance, calls } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockResolvedValue(bucketObject(new Uint8Array([1, 2, 3]), 4));

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
		);

		expect(result.status).toBe('failed');
		expect(calls.writeFiles).toHaveLength(0);
	});

	it('cleans temporary paths when fetching, writing, or extracting the archive fails', async () => {
		for (const failure of ['fetch', 'body', 'write', 'exec'] as const) {
			const { instance, calls } = makeFakeSandbox();
			const bucket = new MemoryBucket();
			if (failure === 'fetch') {
				vi.spyOn(bucket, 'get').mockRejectedValue(new Error('storage unavailable'));
			} else {
				const object = bucketObject(new Uint8Array([1, 2, 3]));
				if (failure === 'body') {
					object.bytes = async () => {
						throw new Error('archive body unavailable');
					};
				}
				vi.spyOn(bucket, 'get').mockResolvedValue(object);
				if (failure === 'write') {
					instance.writeFiles = async () => {
						throw new Error('sandbox write unavailable');
					};
				}
				if (failure === 'exec') {
					const exec = instance.exec.bind(instance);
					instance.exec = async (command, options) => {
						if (command.startsWith('python3 ')) throw new Error('sandbox exec unavailable');
						return exec(command, options);
					};
				}
			}

			const result = await restorePackedWorkspace(
				instance,
				bucket,
				'workspace.zip',
				'/workspace',
				false,
			);

			expect(result.status).toBe('failed');
			expect(calls.exec.some((command) => command.startsWith('rm -rf -- '))).toBe(true);
		}
	});

	it('normalizes a trailing slash and keeps every temporary path inside the workdir', async () => {
		const { instance, calls } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockResolvedValue(bucketObject(new Uint8Array([1, 2, 3])));

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace/',
			false,
		);

		expect(result).toEqual({ status: 'restored', archiveBytes: 3 });
		expect(calls.writeFiles).toHaveLength(1);
		expect(calls.writeFiles[0]).toHaveLength(2);
		expect(
			calls.writeFiles[0].every(({ path }) =>
				path.startsWith('/workspace/.marimohub-packed-restore/'),
			),
		).toBe(true);
		expect(calls.exec[0]).toContain("'/workspace/.marimohub-packed-restore'");
		expect(calls.exec[0]).not.toContain('/workspace.marimohub');
	});

	it('includes extractor stderr in the recovered failure', async () => {
		const { instance } = makeFakeSandbox();
		const exec = instance.exec.bind(instance);
		instance.exec = async (command, options) => {
			if (command.startsWith('python3 ')) {
				return {
					success: false,
					stdout: '',
					stderr: 'packed workspace extraction failed: BadZipFile: invalid central directory',
					error: { code: 'COMMAND_FAILED' },
				};
			}
			return exec(command, options);
		};
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockResolvedValue(bucketObject(new Uint8Array([1, 2, 3])));

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
		);

		expect(result).toMatchObject({ status: 'failed' });
		if (result.status === 'failed') {
			expect(result.error).toHaveProperty(
				'message',
				expect.stringContaining('BadZipFile: invalid central directory'),
			);
		}
	});

	it('preserves the primary failure when temporary cleanup also fails', async () => {
		const { instance } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockRejectedValue(new Error('storage unavailable'));
		instance.exec = async () => {
			throw new Error('cleanup unavailable');
		};

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
		);

		expect(result).toMatchObject({
			status: 'failed',
			error: new Error('storage unavailable'),
		});
	});
});
