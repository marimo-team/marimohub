import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: { dts: true, entry: ['src/node.ts', 'src/worker.ts'] },
	test: { include: ['src/**/*.test.ts'], maxConcurrency: 2 },
});
