import { defineConfig } from 'vite-plus';
import { DUCKDB_EXTENSION_MANIFEST } from './src/extensionManifest';

export default defineConfig({
	pack: {
		dts: true,
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
		include: ['src/**/*.test.ts'],
	},
});
