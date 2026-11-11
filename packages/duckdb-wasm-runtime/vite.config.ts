import { libraryConfig } from '@marimo-hub/vite-config';
import { DUCKDB_EXTENSION_MANIFEST } from './src/extensionManifest';

export default libraryConfig({
	pack: {
		entry: ['src/node.ts', 'src/worker.ts'],
		copy: [
			{
				from: 'node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm',
				to: 'dist',
			},
			...Object.values(DUCKDB_EXTENSION_MANIFEST).map(({ file }) => ({
				from: `assets/extensions/${file}`,
				to: 'dist',
			})),
		],
	},
	test: {
		// Global clearing can erase mocks owned by another concurrent test.
		clearMocks: false,
		// Each concurrent node test owns a WASM worker, so bound peak memory.
		maxConcurrency: 2,
	},
});
