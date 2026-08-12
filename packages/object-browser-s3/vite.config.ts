import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: { dts: true },
	test: {
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
			thresholds: {
				statements: 90,
				branches: 80,
				functions: 90,
				lines: 90,
			},
		},
	},
});
