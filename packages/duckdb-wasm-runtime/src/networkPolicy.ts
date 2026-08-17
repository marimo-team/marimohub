import * as duckdb from '@duckdb/duckdb-wasm/blocking';

type NodeRuntime = typeof duckdb.NODE_RUNTIME;

export const ICEBERG_HTTP_UNAVAILABLE =
	'Direct DuckDB-Wasm remote file callbacks have no policy-enforcing broker and are disabled. ' +
	'Guarded Iceberg HTTP requires a configured parent broker session.';

const LOCAL_PROTOCOLS = new Set<duckdb.DuckDBDataProtocol>([
	duckdb.DuckDBDataProtocol.BUFFER,
	duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
	duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
]);

export function createFailClosedNodeRuntime(base: NodeRuntime = duckdb.NODE_RUNTIME): NodeRuntime {
	const assertFileAllowed = (module: Parameters<NodeRuntime['openFile']>[0], fileId: number) => {
		const file = base.resolveFileInfo(module, fileId);
		assertProtocolAllowed(file?.dataProtocol);
	};
	const denyPathOperation = (): never => {
		assertProtocolAllowed(undefined);
		throw new Error('DuckDB-Wasm filesystem policy failed open.');
	};
	return {
		...base,
		prepareFileHandle: base.prepareFileHandle
			? async (path, protocol) => {
					assertProtocolAllowed(protocol);
					return base.prepareFileHandle!(path, protocol);
				}
			: undefined,
		prepareFileHandles: base.prepareFileHandles
			? async (paths, protocol) => {
					assertProtocolAllowed(protocol);
					return base.prepareFileHandles!(paths, protocol);
				}
			: undefined,
		prepareDBFileHandle: base.prepareDBFileHandle
			? async (path, protocol) => {
					assertProtocolAllowed(protocol);
					return base.prepareDBFileHandle!(path, protocol);
				}
			: undefined,
		openFile(module, fileId, flags) {
			assertFileAllowed(module, fileId);
			return base.openFile(module, fileId, flags);
		},
		readFile(module, fileId, buffer, bytes, location) {
			assertFileAllowed(module, fileId);
			return base.readFile(module, fileId, buffer, bytes, location);
		},
		writeFile(module, fileId, buffer, bytes, location) {
			assertFileAllowed(module, fileId);
			return base.writeFile(module, fileId, buffer, bytes, location);
		},
		truncateFile(module, fileId, newSize) {
			assertFileAllowed(module, fileId);
			return base.truncateFile(module, fileId, newSize);
		},
		getLastFileModificationTime(module, fileId) {
			assertFileAllowed(module, fileId);
			return base.getLastFileModificationTime(module, fileId);
		},
		glob(_module, _pathPtr, _pathLen) {
			denyPathOperation();
		},
		checkFile(_module, _pathPtr, _pathLen) {
			return denyPathOperation();
		},
		checkDirectory(_module, _pathPtr, _pathLen) {
			return denyPathOperation();
		},
		listDirectoryEntries(_module, _pathPtr, _pathLen) {
			return denyPathOperation();
		},
		createDirectory(_module, _pathPtr, _pathLen) {
			denyPathOperation();
		},
		moveFile(_module, _fromPtr, _fromLen, _toPtr, _toLen) {
			denyPathOperation();
		},
		removeFile(_module, _pathPtr, _pathLen) {
			denyPathOperation();
		},
		removeDirectory(_module, _pathPtr, _pathLen) {
			denyPathOperation();
		},
	};
}

export function assertProtocolAllowed(protocol: duckdb.DuckDBDataProtocol | undefined): void {
	if (protocol !== undefined && LOCAL_PROTOCOLS.has(protocol)) return;
	throw new Error(
		`DuckDB-Wasm access through a non-local or unknown data protocol is unavailable. ${ICEBERG_HTTP_UNAVAILABLE}`,
	);
}
