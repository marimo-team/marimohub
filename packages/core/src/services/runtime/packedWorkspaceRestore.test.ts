import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ByteBudget } from './byteBudget';
import { createPackedWorkspaceArchive } from '../../integrations/packedWorkspace';
import type { BucketObjectBody } from '../../ports/bucket';
import { makeFakeSandbox, MemoryBucket } from '../../testing';
import { runPythonCases } from '../../testing/pythonCases';
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

interface ExtractionCase {
	archive: Uint8Array;
	requireGit?: boolean;
	readOnlyParent?: boolean;
	subdirectory?: string;
	/** Files present in the destination before extraction, relative to it. */
	existing?: Record<string, string>;
}

interface ExtractionResult {
	root: string;
	destination: string;
	status: number;
	stderr: string;
}

// One interpreter runs every case: on macOS a fresh python3 per case dominates the test time.
async function runExtractors(cases: ExtractionCase[]): Promise<ExtractionResult[]> {
	const prepared = cases.map((extraction) => {
		const root = mkdtempSync(join(tmpdir(), 'marimohub-packed-'));
		temporaryDirectories.push(root);
		const destination = join(root, 'workspace');
		const temporaryRoot = join(destination, '.marimohub-packed-restore');
		const archivePath = join(temporaryRoot, 'workspace.zip');
		mkdirSync(temporaryRoot, { recursive: true });
		for (const [name, content] of Object.entries(extraction.existing ?? {})) {
			writeFileSync(join(destination, name), content);
		}
		writeFileSync(archivePath, extraction.archive);
		if (extraction.readOnlyParent) chmodSync(root, 0o555);
		return {
			root,
			destination,
			argv: [
				archivePath,
				temporaryRoot,
				destination,
				extraction.requireGit ? '1' : '0',
				extraction.subdirectory ?? '',
			],
		};
	});
	try {
		const results = await runPythonCases(
			EXTRACT_PACKED_WORKSPACE,
			prepared.map(({ argv }) => ({ argv })),
			'extract.py',
		);
		return prepared.map(({ root, destination }, index) => ({
			root,
			destination,
			status: results[index].status,
			stderr: results[index].stderr,
		}));
	} finally {
		cases.forEach((extraction, index) => {
			if (extraction.readOnlyParent) chmodSync(prepared[index].root, 0o755);
		});
	}
}

async function runExtractor(
	archive: Uint8Array,
	requireGit: boolean,
	readOnlyParent = false,
	subdirectory = '',
): Promise<ExtractionResult> {
	const [result] = await runExtractors([{ archive, requireGit, readOnlyParent, subdirectory }]);
	return result;
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.concurrent('packed workspace extractor', () => {
	it('restores binary workspace files and required Git metadata', async () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([
				['app.py', encode('print(1)')],
				['data/blob.bin', new Uint8Array([0, 255, 1])],
				['分析/empty.txt', new Uint8Array()],
			]),
			git: new Map([['HEAD', encode('ref: refs/heads/main\n')]]),
		});
		const { destination, status, stderr } = await runExtractor(archive, true, true);

		expect(status, stderr).toBe(0);
		expect(readFileSync(join(destination, 'app.py'), 'utf8')).toBe('print(1)');
		expect(readFileSync(join(destination, 'data/blob.bin'))).toEqual(Buffer.from([0, 255, 1]));
		expect(readFileSync(join(destination, '分析/empty.txt'))).toHaveLength(0);
		expect(readFileSync(join(destination, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
	});

	it('places workspace entries under a subdirectory while Git metadata stays at the root', async () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([
				['app.py', encode('print(1)')],
				['lib/util.py', encode('x = 1')],
			]),
			git: new Map([['HEAD', encode('ref: refs/heads/main\n')]]),
		});
		const { destination, status, stderr } = await runExtractor(archive, true, false, 'python/apps');

		expect(status, stderr).toBe(0);
		expect(readFileSync(join(destination, 'python/apps/app.py'), 'utf8')).toBe('print(1)');
		expect(readFileSync(join(destination, 'python/apps/lib/util.py'), 'utf8')).toBe('x = 1');
		expect(readFileSync(join(destination, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
		expect(existsSync(join(destination, 'app.py'))).toBe(false);
	});

	it('rejects unsafe workspace subdirectories', async () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
			git: new Map([['HEAD', encode('ref: refs/heads/main\n')]]),
		});
		const subdirectories = [
			'../escape',
			'a/../b',
			'a//b',
			'/absolute',
			'trailing/',
			'.',
			'.git',
			'.git/hooks',
			'a/.git',
			'A/.GIT',
			'.marimohub-packed-restore/x',
			'a\\b',
			'a\tb',
			'a\u007fb',
		];
		const results = await runExtractors(
			subdirectories.map((subdirectory) => ({ archive, requireGit: true, subdirectory })),
		);
		results.forEach(({ destination, status, stderr }, index) => {
			const subdirectory = subdirectories[index];
			expect(status, subdirectory).toBe(1);
			expect(stderr, subdirectory).toContain('unsafe workspace subdirectory');
			expect(existsSync(join(destination, 'app.py')), subdirectory).toBe(false);
		});
	});

	it.each(['données', 'my dir'])(
		'places workspace entries under the subdirectory %j',
		async (dir) => {
			const archive = createPackedWorkspaceArchive({
				workspace: new Map([['app.py', encode('print(1)')]]),
				git: new Map([['HEAD', encode('ref: refs/heads/main\n')]]),
			});
			const { destination, status, stderr } = await runExtractor(archive, true, false, dir);

			expect(status, stderr).toBe(0);
			expect(readFileSync(join(destination, dir, 'app.py'), 'utf8')).toBe('print(1)');
		},
	);

	it('rejects traversal paths before replacing an existing destination', async () => {
		const [{ destination, status, stderr }] = await runExtractors([
			{ archive: zipSync({ '../escape.txt': encode('bad') }), existing: { 'keep.txt': 'keep' } },
		]);

		expect(status).toBe(1);
		expect(stderr).toContain('unsafe or duplicate archive path');
		expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
	});

	it('refuses to merge into a non-empty workspace', async () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
		});
		const [{ destination, status, stderr }] = await runExtractors([
			{ archive, existing: { 'keep.txt': 'keep' } },
		]);

		expect(status).toBe(1);
		expect(stderr).toContain('workspace is not empty');
		expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
		expect(() => readFileSync(join(destination, 'app.py'))).toThrow();
	});

	it('rejects symlinks, FIFOs, and incomplete pull-mode Git metadata', async () => {
		const special = [0o120777 * 65536, 0o010644 * 65536].map((attrs) =>
			zipSync({ link: [encode('target'), { os: 3, attrs }] }),
		);
		const withoutHead = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
			git: new Map([['config', encode('config')]]),
		});
		const [symlink, fifo, incompleteGit] = await runExtractors([
			{ archive: special[0] },
			{ archive: special[1] },
			{ archive: withoutHead, requireGit: true },
		]);

		expect(symlink.status, symlink.stderr).toBe(1);
		expect(fifo.status, fifo.stderr).toBe(1);
		expect(incompleteGit.status).toBe(1);
		expect(incompleteGit.stderr).toContain('Git metadata is incomplete');
	});

	it.each([
		{ label: 'S_IFREG with 0o644 permissions', mode: 0o100644 },
		{ label: 'permission-only 0o644', mode: 0o000644 },
	])('restores a regular file encoded as $label', async ({ mode }) => {
		const archive = zipSync({ 'app.py': [encode('print(1)'), { os: 3, attrs: mode * 65536 }] });
		const { destination, status, stderr } = await runExtractor(archive, false);

		expect(status, stderr).toBe(0);
		expect(readFileSync(join(destination, 'app.py'), 'utf8')).toBe('print(1)');
	});

	it('rejects a truncated archive', async () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
		});
		expect((await runExtractor(archive.subarray(0, archive.byteLength - 10), false)).status).toBe(
			1,
		);
	});

	it('rejects empty, directory-bearing, encrypted, duplicate, and CRC-invalid archives', async () => {
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

		const archives = {
			empty,
			directory,
			encrypted,
			duplicate,
			badCrc,
			absolute,
			backslash,
			emptySegment,
		};
		const results = await runExtractors(Object.values(archives).map((archive) => ({ archive })));
		Object.keys(archives).forEach((label, index) => {
			expect(results[index].status, label).toBe(1);
		});
	});

	it('rejects declared per-file and aggregate workspace limits before extraction', async () => {
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

		const [perFileResult, aggregateResult] = await runExtractors([
			{ archive: perFile },
			{ archive: aggregate },
		]);
		expect(perFileResult.status).toBe(1);
		expect(aggregateResult.status).toBe(1);
	});

	it('enforces Git aggregate and file-count limits separately from workspace limits', async () => {
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

		const [aggregateResult, tooManyResult] = await runExtractors([
			{ archive: aggregate, requireGit: true },
			{ archive: tooMany, requireGit: true },
		]);
		expect(aggregateResult.status).toBe(1);
		expect(tooManyResult.status).toBe(1);
	});

	it('rejects more than 1000 workspace files', async () => {
		const archive = zipSync(
			Object.fromEntries(
				Array.from({ length: 1001 }, (_, index) => [`${index}.txt`, new Uint8Array()]),
			),
		);

		expect((await runExtractor(archive, false)).status).toBe(1);
	});

	it('rejects an archive path reserved for restore files', async () => {
		const archive = zipSync({
			'.marimohub-packed-restore/payload': encode('conflict'),
		});
		expect((await runExtractor(archive, false)).status).toBe(1);
	});
});

describe('restorePackedWorkspace', () => {
	it('fails fast without waiting for readiness or touching the sandbox when the read fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		const storageError = new Error('archive read failed');
		vi.spyOn(bucket, 'get').mockRejectedValue(storageError);
		const waitUntilReady = vi.fn(() => new Promise<void>(() => {}));

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
			'',
			waitUntilReady,
		);

		expect(result).toEqual({ status: 'failed', error: storageError });
		expect(waitUntilReady).not.toHaveBeenCalled();
		expect(calls.exec).toHaveLength(0);
		expect(calls.writeFiles).toHaveLength(0);
	});

	it.each([undefined, 1] as const)(
		'returns failed instead of throwing when readiness rejects (budget: %s)',
		async (capacity) => {
			const { instance, calls } = makeFakeSandbox();
			const bucket = new MemoryBucket();
			vi.spyOn(bucket, 'get').mockResolvedValue(bucketObject(new Uint8Array([1, 2, 3])));
			const bootError = new Error('pod unavailable');

			const result = await restorePackedWorkspace(
				instance,
				bucket,
				'workspace.zip',
				'/workspace',
				false,
				'',
				() => Promise.reject(bootError),
				capacity === undefined ? undefined : new ByteBudget(capacity),
			);

			expect(result).toEqual({ status: 'failed', error: bootError });
			expect(calls.exec).toHaveLength(0);
			expect(calls.writeFiles).toHaveLength(0);
		},
	);

	it('prefetches within budget and releases the reservation once the archive is written', async () => {
		const { instance, calls } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		const object = bucketObject(new Uint8Array([1, 2, 3]));
		const bytes = vi.spyOn(object, 'bytes');
		vi.spyOn(bucket, 'get').mockResolvedValue(object);
		const budget = new ByteBudget(3);
		const ready = Promise.withResolvers<void>();
		let availableAtWrite: number | undefined;
		const writeFiles = instance.writeFiles.bind(instance);
		instance.writeFiles = async (files) => {
			availableAtWrite = budget.available;
			await writeFiles(files);
		};

		const restored = restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
			'',
			() => ready.promise,
			budget,
		);
		await vi.waitFor(() => expect(bytes).toHaveBeenCalled());
		expect(calls.writeFiles).toHaveLength(0);
		ready.resolve();

		expect(await restored).toEqual({ status: 'restored', archiveBytes: 3 });
		expect(availableAtWrite).toBe(0);
		expect(budget.available).toBe(3);
	});

	it('reads an over-budget archive only after readiness and still restores it', async () => {
		const { instance } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		const object = bucketObject(new Uint8Array([1, 2, 3]));
		const bytes = vi.spyOn(object, 'bytes');
		vi.spyOn(bucket, 'get').mockResolvedValue(object);
		const budget = new ByteBudget(2);
		const ready = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();

		const restored = restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
			'',
			() => {
				waiting.resolve();
				return ready.promise;
			},
			budget,
		);
		await waiting.promise;
		expect(bytes).not.toHaveBeenCalled();
		ready.resolve();

		expect(await restored).toEqual({ status: 'restored', archiveBytes: 3 });
		expect(budget.available).toBe(2);
	});

	it('releases the reservation when the restore fails', async () => {
		const { instance } = makeFakeSandbox();
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockResolvedValue(bucketObject(new Uint8Array([1, 2, 3]), 4));
		const budget = new ByteBudget(8);

		const result = await restorePackedWorkspace(
			instance,
			bucket,
			'workspace.zip',
			'/workspace',
			false,
			'',
			async () => {},
			budget,
		);

		expect(result.status).toBe('failed');
		expect(budget.available).toBe(8);
	});

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

	it.each(['.git', 'a/.git', 'A/.GIT', 'a\nb'])(
		'rejects the workspace subdirectory %j before fetching the archive',
		async (subdirectory) => {
			const { instance } = makeFakeSandbox();
			const bucket = new MemoryBucket();
			const get = vi.spyOn(bucket, 'get');

			const result = await restorePackedWorkspace(
				instance,
				bucket,
				'workspace.zip',
				'/workspace',
				true,
				subdirectory,
			);

			expect(result.status).toBe('failed');
			expect(get).not.toHaveBeenCalled();
		},
	);

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
		expect(calls.exec).toHaveLength(0);
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

	it('cleans temporary paths only after a sandbox write started', async () => {
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
			expect(calls.exec.some((command) => command.startsWith('rm -rf -- '))).toBe(
				failure === 'write' || failure === 'exec',
			);
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
		vi.spyOn(bucket, 'get').mockResolvedValue(bucketObject(new Uint8Array([1, 2, 3])));
		instance.writeFiles = async () => {
			throw new Error('sandbox write unavailable');
		};
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
			error: new Error('sandbox write unavailable'),
		});
	});
});
