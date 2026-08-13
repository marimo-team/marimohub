import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: { dts: true },
	test: { include: ['src/**/*.test.ts'] },
});
