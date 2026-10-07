import { expect, test } from '@playwright/test';
import { harness } from './harness';

for (const sandboxBasePath of ['studio/', 'studio/?base=1', 'studio/#section']) {
	test(`normalizes sandbox base ${sandboxBasePath}`, async ({ page }) => {
		const server = await harness({ sandboxBasePath });
		try {
			await page.goto(`${server.hostOrigin}/?__mh_path=data%2F`);
			await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('connected');
			const source = await page.locator('iframe').getAttribute('src');
			expect(new URL(source!).pathname).toBe('/studio/data/');
			expect(new URL(source!).origin).toBe(server.childOrigin);
		} finally {
			await server.close();
		}
	});
}

test.describe('sandbox fixture URL construction', () => {
	let server: Awaited<ReturnType<typeof harness>>;
	test.beforeAll(async () => {
		server = await harness({ sandboxBasePath: '/proxy/current/' });
	});
	test.afterAll(async () => {
		await server.close();
	});

	test('excludes Hub-owned parameters from the initial iframe URL', async ({ page }) => {
		await page.goto(
			`${server.hostOrigin}/?provider=private&access_token=secret&__mh_path=studio%2F&id=1`,
		);
		await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('connected');
		const source = new URL((await page.locator('iframe').getAttribute('src'))!);
		expect(source.pathname).toBe('/proxy/current/studio/');
		expect([...source.searchParams]).toEqual([['id', '1']]);
		expect(new URL(page.url()).searchParams.get('provider')).toBe('private');
	});

	test('honors explicit child fixtures with a sandbox base configured', async ({ page }) => {
		const child = `${server.childOrigin}/incompatible`;
		const search = new URLSearchParams({ child, __mh_path: 'studio/data/' });
		await page.goto(`${server.hostOrigin}/?${search}`);
		await expect(page.locator('iframe')).toHaveAttribute('src', child);
		await expect(page.frameLocator('iframe').getByText('Unsupported notebook')).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('unavailable');
	});
});
