import * as duckdb from '@duckdb/duckdb-wasm/blocking';
import { describe, expect, it, vi } from 'vitest';
import { assertProtocolAllowed, createFailClosedNodeRuntime } from './networkPolicy';

describe('DuckDB-Wasm network policy', () => {
	it.each([
		undefined,
		duckdb.DuckDBDataProtocol.HTTP,
		duckdb.DuckDBDataProtocol.S3,
		duckdb.DuckDBDataProtocol.NODE_FS,
		999,
	])('rejects non-local or unknown protocol %s', (protocol) => {
		expect(() => assertProtocolAllowed(protocol as duckdb.DuckDBDataProtocol | undefined)).toThrow(
			/non-local or unknown.*policy-enforcing broker/i,
		);
	});

	it.each([
		duckdb.DuckDBDataProtocol.BUFFER,
		duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
		duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
	] as const)('allows explicitly listed local protocol %s', (protocol) => {
		expect(() => assertProtocolAllowed(protocol)).not.toThrow();
	});

	it('blocks missing file metadata before delegating', () => {
		const openFile = vi.fn(() => 1);
		const runtime = createFailClosedNodeRuntime({
			...duckdb.NODE_RUNTIME,
			resolveFileInfo: vi.fn(() => null),
			openFile,
		});

		expect(() => runtime.openFile({} as never, 7, duckdb.FileFlags.FILE_FLAGS_READ)).toThrow(
			/non-local or unknown/i,
		);
		expect(openFile).not.toHaveBeenCalled();
	});

	it('blocks remote files before delegating even if the SDK runtime gains HTTP support', () => {
		const delegates = {
			openFile: vi.fn(() => 1),
			readFile: vi.fn(() => 1),
			writeFile: vi.fn(() => 1),
			truncateFile: vi.fn(() => 0),
			getLastFileModificationTime: vi.fn(() => 0),
		};
		const base = {
			...duckdb.NODE_RUNTIME,
			resolveFileInfo: vi.fn(() => ({
				cacheEpoch: 0,
				fileId: 7,
				fileName: 'remote',
				dataProtocol: duckdb.DuckDBDataProtocol.HTTP,
				dataUrl: 'https://private.example/data',
			})),
			...delegates,
		};
		const runtime = createFailClosedNodeRuntime(base);

		const operations = [
			() => runtime.openFile({} as never, 7, duckdb.FileFlags.FILE_FLAGS_READ),
			() => runtime.readFile({} as never, 7, 0, 1, 0),
			() => runtime.writeFile({} as never, 7, 0, 1, 0),
			() => runtime.truncateFile({} as never, 7, 0),
			() => runtime.getLastFileModificationTime({} as never, 7),
		];
		for (const operation of operations) {
			expect(operation).toThrow(/policy-enforcing broker/i);
		}
		for (const delegate of Object.values(delegates)) {
			expect(delegate).not.toHaveBeenCalled();
		}
	});

	it('preserves every synchronous operation for allowed local files', () => {
		const base = {
			...duckdb.NODE_RUNTIME,
			resolveFileInfo: vi.fn(() => ({
				cacheEpoch: 0,
				fileId: 7,
				fileName: 'local',
				dataProtocol: duckdb.DuckDBDataProtocol.BUFFER,
				dataUrl: 'buffer',
			})),
			openFile: vi.fn(() => 11),
			readFile: vi.fn(() => 12),
			writeFile: vi.fn(() => 13),
			truncateFile: vi.fn(() => 14),
			getLastFileModificationTime: vi.fn(() => 15),
		};
		const runtime = createFailClosedNodeRuntime(base);

		expect([
			runtime.openFile({} as never, 7, duckdb.FileFlags.FILE_FLAGS_READ),
			runtime.readFile({} as never, 7, 0, 1, 0),
			runtime.writeFile({} as never, 7, 0, 1, 0),
			runtime.truncateFile({} as never, 7, 0),
			runtime.getLastFileModificationTime({} as never, 7),
		]).toEqual([11, 12, 13, 14, 15]);
		expect(base.resolveFileInfo).toHaveBeenCalledTimes(5);
	});

	it('blocks every asynchronous remote-file preparation hook', async () => {
		const prepareFileHandle = vi.fn(async () => []);
		const prepareFileHandles = vi.fn(async () => []);
		const prepareDBFileHandle = vi.fn(async () => []);
		const runtime = createFailClosedNodeRuntime({
			...duckdb.NODE_RUNTIME,
			prepareFileHandle,
			prepareFileHandles,
			prepareDBFileHandle,
		});

		await expect(
			runtime.prepareFileHandle!('https://private.example/data', duckdb.DuckDBDataProtocol.HTTP),
		).rejects.toThrow(/policy-enforcing broker/i);
		await expect(
			runtime.prepareFileHandles!(['s3://private-bucket/data'], duckdb.DuckDBDataProtocol.S3),
		).rejects.toThrow(/policy-enforcing broker/i);
		await expect(
			runtime.prepareDBFileHandle!('https://private.example/db', duckdb.DuckDBDataProtocol.HTTP),
		).rejects.toThrow(/policy-enforcing broker/i);
		expect(prepareFileHandle).not.toHaveBeenCalled();
		expect(prepareFileHandles).not.toHaveBeenCalled();
		expect(prepareDBFileHandle).not.toHaveBeenCalled();
	});

	it('blocks every path-based host filesystem hook before delegating', () => {
		const delegates = {
			glob: vi.fn(),
			checkFile: vi.fn(() => true),
			checkDirectory: vi.fn(() => true),
			listDirectoryEntries: vi.fn(() => true),
			createDirectory: vi.fn(),
			moveFile: vi.fn(),
			removeFile: vi.fn(),
			removeDirectory: vi.fn(),
		};
		const runtime = createFailClosedNodeRuntime({ ...duckdb.NODE_RUNTIME, ...delegates });
		const module = {} as never;

		const operations = [
			() => runtime.glob(module, 0, 0),
			() => runtime.checkFile(module, 0, 0),
			() => runtime.checkDirectory(module, 0, 0),
			() => runtime.listDirectoryEntries(module, 0, 0),
			() => runtime.createDirectory(module, 0, 0),
			() => runtime.moveFile(module, 0, 0, 0, 0),
			() => runtime.removeFile(module, 0, 0),
			() => runtime.removeDirectory(module, 0, 0),
		];
		for (const operation of operations) expect(operation).toThrow(/policy-enforcing broker/i);
		for (const delegate of Object.values(delegates)) expect(delegate).not.toHaveBeenCalled();
	});

	it('delegates allowed asynchronous preparation without changing its result', async () => {
		const expected = [] satisfies Awaited<
			ReturnType<NonNullable<typeof duckdb.NODE_RUNTIME.prepareFileHandle>>
		>;
		const prepareFileHandle = vi.fn(async () => expected);
		const runtime = createFailClosedNodeRuntime({
			...duckdb.NODE_RUNTIME,
			prepareFileHandle,
		});

		await expect(
			runtime.prepareFileHandle!('buffer', duckdb.DuckDBDataProtocol.BUFFER),
		).resolves.toBe(expected);
		expect(prepareFileHandle).toHaveBeenCalledWith('buffer', duckdb.DuckDBDataProtocol.BUFFER);
	});
});
