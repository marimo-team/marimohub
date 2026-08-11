import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const PORT = 4321;
const BASE_URL = `http://localhost:${PORT}`;

// CI runs one browser per matrix job via E2E_BROWSER (see .github/workflows/e2e.yml).
// The local default is chromium so `pnpm e2e` only needs the chromium install.
const allProjects = [
	{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
	{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
	{ name: 'webkit', use: { ...devices['Desktop Safari'] } },
];
const browsers = (process.env.E2E_BROWSER ?? 'chromium').split(',');
for (const browser of browsers) {
	if (!allProjects.some((p) => p.name === browser)) {
		throw new Error(`Unknown E2E_BROWSER "${browser}" (expected chromium, firefox, or webkit)`);
	}
}

// The lifecycle spec needs a real kernel through the local compute adapter, so
// it runs only on Chromium and can be skipped on hosts without uv.
const LIFECYCLE_SPEC = /session\.lifecycle\.spec\.ts$/;
const runLifecycle = browsers.includes('chromium') && process.env.E2E_LIFECYCLE !== '0';

// Boots apps/server serving the prebuilt SPA with memory storage and dev auth.
// State is shared across the single server process, so tests run serially with unique names.
export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI
		? [
				['github'],
				['junit', { outputFile: 'test-results/junit.xml' }],
				['html', { open: 'never' }],
				['list'],
			]
		: 'list',
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
	},
	projects: [
		...allProjects
			.filter((p) => browsers.includes(p.name))
			.map((p) => ({ ...p, testIgnore: LIFECYCLE_SPEC })),
		...(runLifecycle
			? [
					{
						name: 'lifecycle',
						testMatch: LIFECYCLE_SPEC,
						use: { ...devices['Desktop Chrome'] },
					},
				]
			: []),
	],
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
			MARIMOHUB_COMPUTE_BACKEND: runLifecycle ? 'local' : 'none',
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_STATIC_ROOT: 'packages/web/dist',
		},
	},
});
