import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
	testDir: './browser',
	workers: 1,
	timeout: 30_000,
	use: { trace: 'retain-on-failure' },
	projects: [
		...['chromium', 'firefox', 'webkit'].map((name) => ({
			name,
			testIgnore: /runtime\.spec\.ts$/,
			use: {
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
			testMatch: /runtime\.spec\.ts$/,
			use: { ...devices['Desktop Chrome'] },
			timeout: 180_000,
		},
	],
});
