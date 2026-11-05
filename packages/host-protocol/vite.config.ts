import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		dts: true,
		entry: ['src/index.ts', 'src/bridge.ts'],
	},
	test: {
		include: ['src/**/*.test.ts'],
	},
});
