import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	createPackedWorkspaceArchive,
	isPackedWorkspaceInputWithinLimit,
	packedWorkspaceInputBytes,
} from './packedWorkspace';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function zipCompressionMethods(archive: Uint8Array): Map<string, number> {
	const methods = new Map<string, number>();
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	for (let offset = 0; offset <= archive.byteLength - 46; offset++) {
		if (view.getUint32(offset, true) !== 0x02014b50) continue;
		const nameLength = view.getUint16(offset + 28, true);
		const name = decode(archive.subarray(offset + 46, offset + 46 + nameLength));
		methods.set(name, view.getUint16(offset + 10, true));
	}
	return methods;
}

describe('createPackedWorkspaceArchive', () => {
	it('packs nested, hidden, and binary workspace files', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([
				['app.py', encode('print(1)')],
				['data/.hidden', encode('secret')],
				['data/blob.bin', new Uint8Array([0, 255, 1])],
				['分析/empty.txt', new Uint8Array()],
			]),
		});

		const files = unzipSync(archive);
		expect(Object.keys(files).sort()).toEqual([
			'app.py',
			'data/.hidden',
			'data/blob.bin',
			'分析/empty.txt',
		]);
		expect(decode(files['app.py'])).toBe('print(1)');
		expect(files['data/blob.bin']).toEqual(new Uint8Array([0, 255, 1]));
		expect(files['分析/empty.txt']).toHaveLength(0);
	});

	it('replaces workspace .git entries with separately materialized Git metadata', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([
				['app.py', encode('print(1)')],
				['.gitignore', encode('.venv')],
				['.git/HEAD', encode('workspace head')],
				['.git/config', encode('workspace config')],
			]),
			git: new Map([
				['HEAD', encode('ref: refs/heads/main\n')],
				['objects/pack/data', new Uint8Array([1, 2, 3])],
			]),
		});

		const files = unzipSync(archive);
		expect(Object.keys(files).sort()).toEqual([
			'.git/HEAD',
			'.git/objects/pack/data',
			'.gitignore',
			'app.py',
		]);
		expect(decode(files['.git/HEAD'])).toBe('ref: refs/heads/main\n');
	});

	it.each(['', '/app.py', 'dir/', 'dir//app.py', './app.py', '../app.py', 'dir/../app.py', 'a\\b'])(
		'rejects unsafe workspace path %j',
		(path) => {
			expect(() =>
				createPackedWorkspaceArchive({ workspace: new Map([[path, encode('bad')]]) }),
			).toThrow('Unsafe packed workspace path');
		},
	);

	it('rejects unsafe Git paths after placing them under .git', () => {
		expect(() =>
			createPackedWorkspaceArchive({
				workspace: new Map([['app.py', encode('ok')]]),
				git: new Map([['../escape', encode('bad')]]),
			}),
		).toThrow('Unsafe packed workspace path');
	});

	it('rejects duplicate paths even when a map-like input yields them', () => {
		const workspace = {
			*[Symbol.iterator]() {
				yield ['app.py', encode('first')] as const;
				yield ['app.py', encode('second')] as const;
			},
		} as unknown as ReadonlyMap<string, Uint8Array>;

		expect(() => createPackedWorkspaceArchive({ workspace })).toThrow(
			'Duplicate packed workspace path: app.py',
		);
	});

	it('packs object prototype names as ordinary paths', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([
				['__proto__', encode('prototype')],
				['constructor', encode('constructor')],
			]),
		});

		const files = unzipSync(archive);
		expect(decode(Reflect.get(files, '__proto__'))).toBe('prototype');
		expect(decode(Reflect.get(files, 'constructor'))).toBe('constructor');
	});

	it('stores pre-compressed Git objects without deflating them again', () => {
		const archive = createPackedWorkspaceArchive({
			workspace: new Map([['app.py', encode('print(1)')]]),
			git: new Map([
				['HEAD', encode('ref: refs/heads/main\n')],
				['objects/pack/pack-a.pack', new Uint8Array([1, 2, 3])],
			]),
		});

		expect(zipCompressionMethods(archive)).toEqual(
			new Map([
				['app.py', 8],
				['.git/HEAD', 8],
				['.git/objects/pack/pack-a.pack', 0],
			]),
		);
	});

	it('counts only archive entries when enforcing the synchronous packing limit', () => {
		const input = {
			workspace: new Map([
				['app.py', new Uint8Array(2)],
				['.git/HEAD', new Uint8Array(100)],
			]),
			git: new Map([['HEAD', new Uint8Array(3)]]),
		};

		expect(packedWorkspaceInputBytes(input)).toBe(5);
		expect(isPackedWorkspaceInputWithinLimit(input, 5)).toBe(true);
		expect(isPackedWorkspaceInputWithinLimit(input, 4)).toBe(false);
	});
});
