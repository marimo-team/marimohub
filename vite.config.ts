import { defineConfig } from 'vite-plus';

// Root Vite+ workspace config. Per-package configs live in each package and
// inherit/override these defaults. See https://viteplus.dev/guide/
export default defineConfig({
	staged: {
		'*': 'vp check --fix',
	},
	fmt: {
		useTabs: true,
		singleQuote: true,
	},
	lint: {},
	run: {
		cache: true,
	},
});
