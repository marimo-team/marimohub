import { defineConfig } from 'vite-plus';
export default defineConfig({
	pack: {
		entry: ['src/host.ts', 'src/notebook.ts', 'src/protocol.ts', 'src/query.ts', 'src/runtime.ts'],
		dts: true,
	},
	test: { include: ['src/**/*.test.ts'] },
});
