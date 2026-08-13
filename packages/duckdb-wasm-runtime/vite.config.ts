import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		dts: true,
		entry: ['src/node.ts', 'src/worker.ts'],
		copy: [
			{
				from: 'node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm',
				to: 'dist',
			},
		],
	},
	test: {
		include: ['src/**/*.test.ts'],
	},
});
