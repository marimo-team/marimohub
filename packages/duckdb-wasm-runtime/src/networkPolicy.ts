import * as duckdb from '@duckdb/duckdb-wasm/blocking';

type NodeRuntime = typeof duckdb.NODE_RUNTIME;

export const ICEBERG_HTTP_UNAVAILABLE =
	'DuckDB-Wasm 1.32 Node file callbacks are synchronous, but IntegrationProbe is asynchronous; ' +
	'no policy-enforcing broker exists for catalog, redirect, and object-store requests.';

export function createFailClosedNodeRuntime(base: NodeRuntime = duckdb.NODE_RUNTIME): NodeRuntime {
	const assertFileAllowed = (module: Parameters<NodeRuntime['openFile']>[0], fileId: number) => {
		const file = base.resolveFileInfo(module, fileId);
		assertProtocolAllowed(file?.dataProtocol);
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
	};
}

export function assertProtocolAllowed(protocol: duckdb.DuckDBDataProtocol | undefined): void {
	if (protocol === duckdb.DuckDBDataProtocol.HTTP || protocol === duckdb.DuckDBDataProtocol.S3) {
		throw new Error(`DuckDB-Wasm remote data access is unavailable. ${ICEBERG_HTTP_UNAVAILABLE}`);
	}
}
