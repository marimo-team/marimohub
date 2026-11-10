import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
	testDir: './browser',
	workers: 2,
	timeout: 30_000,
	use: { trace: 'retain-on-failure' },
	projects: [
		...['chromium', 'firefox', 'webkit'].map((name) => ({
			name,
			testIgnore: /runtime\.spec\.ts$/,
			use: {
				// Headless shell stalls COOP navigations opened by middle or modified clicks.
				...(name === 'chromium' ? { channel: 'chromium' } : {}),
				...devices[
					name === 'chromium'
						? 'Desktop Chrome'
						: name === 'firefox'
							? 'Desktop Firefox'
							: 'Desktop Safari'
				],
			},
		})),
		{
			name: 'runtime',
			// Offline cases reuse the uv cache warmed by earlier version checks.
			workers: 1,
			testMatch: /runtime\.spec\.ts$/,
			use: { ...devices['Desktop Chrome'] },
			timeout: 180_000,
		},
	],
});
