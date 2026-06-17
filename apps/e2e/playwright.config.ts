import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const PORT = 4321;
const BASE_URL = `http://localhost:${PORT}`;

// Boots apps/server serving the prebuilt SPA, wired to the local ports (memory
// storage, dev auth, no compute) for zero external deps. State is shared across
// the single server process, so tests run serially with unique names.
export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// Builds web + server (cached `vp run` tasks) and serves the SPA from
	// packages/web/dist. A warm `e2e:serve` server is reused via reuseExistingServer.
	webServer: {
		command:
			'pnpm exec vp run --filter @marimo-hub/web --filter @marimo-hub/server build && node apps/server/dist/index.mjs',
		cwd: repoRoot,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			PORT: String(PORT),
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			MARIMOHUB_COMPUTE_BACKEND: 'none',
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_STATIC_ROOT: 'packages/web/dist',
		},
	},
});
