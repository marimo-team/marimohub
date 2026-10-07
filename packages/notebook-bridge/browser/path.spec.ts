import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { harness } from './harness';

async function connectedFrame(page: Page) {
	await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('connected');
	return page.frames().find((frame) => frame.parentFrame())!;
}

for (const basePath of ['/', '/hub/proxy/current/']) {
	test.describe(`path mirroring under ${basePath}`, () => {
		let server: Awaited<ReturnType<typeof harness>>;
		test.beforeAll(async () => {
			server = await harness({ sandboxBasePath: basePath });
		});
		test.afterAll(async () => {
			await server.close();
		});

		test('restores shared paths and mirrors History changes without a frame reload', async ({
			page,
		}) => {
			await page.goto(`${server.hostOrigin}/?__mh_path=studio%2Fdata%2F&id=1`);
			const frame = await connectedFrame(page);
			expect(new URL(frame.url()).pathname).toBe(`${basePath}studio/data/`);
			expect(new URL(frame.url()).searchParams.has('__mh_path')).toBe(false);
			const loads = await page.evaluate(() => window.loads);
			await frame.evaluate(() => {
				document.body.dataset.document = 'original';
			});
			await frame.evaluate(
				(base) => history.pushState({ view: 'settings' }, '', `${base}studio/settings/?id=2`),
				basePath,
			);
			await expect
				.poll(() => new URL(page.url()).searchParams.get('__mh_path'))
				.toBe('studio/settings/');
			expect(new URL(page.url()).searchParams.get('id')).toBe('2');
			expect(await page.evaluate(() => window.loads)).toBe(loads);
			await frame.evaluate(() => history.back());
			await expect
				.poll(() => new URL(page.url()).searchParams.get('__mh_path'))
				.toBe('studio/data/');
			await frame.evaluate(() => history.forward());
			await expect
				.poll(() => new URL(page.url()).searchParams.get('__mh_path'))
				.toBe('studio/settings/');
			await expect(frame.locator('body')).toHaveAttribute('data-document', 'original');
			const shared = page.url();
			expect(shared).not.toContain('/proxy/');
			await page.reload();
			const restored = await connectedFrame(page);
			expect(new URL(restored.url()).pathname).toBe(`${basePath}studio/settings/`);
			expect(new URL(restored.url()).searchParams.get('id')).toBe('2');
			await restored.evaluate((base) => history.replaceState({}, '', base), basePath);
			await expect(page).toHaveURL(`${server.hostOrigin}/`);
		});

		test('preserves explicit paths in cross-app links', async ({ page }) => {
			await page.goto(`${server.hostOrigin}/?navigation=1`);
			const frame = await connectedFrame(page);
			await frame.evaluate(() => {
				document.body.insertAdjacentHTML(
					'beforeend',
					'<a href="/app/match?__mh_path=studio%2Fdata%2F&id=1">Other view</a>',
				);
			});
			const link = frame.getByRole('link', { name: 'Other view' });
			const destination = `${server.hostOrigin}/prefix/app/match?id=1&__mh_path=studio%2Fdata%2F`;
			await expect(link).toHaveAttribute('href', destination);
			await link.click();
			await expect(page).toHaveURL(destination);
		});

		test('retains a missing deep link through handshake failure and recovers on reload', async ({
			page,
		}) => {
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			const missing = `${server.childOrigin}${basePath}studio/missing/`;
			await page.route(missing, (route) =>
				route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>View not found</h1>' }),
			);
			const shared = `${server.hostOrigin}/?__mh_path=studio%2Fmissing%2F`;
			await page.goto(shared);
			await expect(
				page.frameLocator('iframe').getByRole('heading', { name: 'View not found' }),
			).toBeVisible();
			await expect
				.poll(() => page.evaluate(() => window.bridge?.status), { timeout: 15_000 })
				.toBe('unavailable');
			await expect(page).toHaveURL(shared);
			expect(await page.evaluate(() => window.updates)).toBe(0);
			expect(errors).toEqual([]);
			await page.unroute(missing);
			await page.reload();
			const restored = await connectedFrame(page);
			await expect(
				page.frameLocator('iframe').getByText('Notebook', { exact: true }),
			).toBeVisible();
			expect(new URL(restored.url()).pathname).toBe(`${basePath}studio/missing/`);
			await expect(page).toHaveURL(shared);
		});

		test('clears a restored path when the frame moves to an unrepresentable location', async ({
			page,
		}) => {
			await page.goto(`${server.hostOrigin}/?__mh_path=studio%2Fdata%2F&id=1`);
			const frame = await connectedFrame(page);
			expect(new URL(frame.url()).pathname).toBe(`${basePath}studio/data/`);
			await frame.evaluate(
				(base) => history.pushState({}, '', `${base}studio%2Fencoded/?id=2`),
				basePath,
			);
			await expect(page).toHaveURL(`${server.hostOrigin}/?id=2`);
			if (basePath !== '/') {
				await frame.evaluate(
					(base) => history.pushState({}, '', `${base}studio/data/?id=3`),
					basePath,
				);
				await expect
					.poll(() => new URL(page.url()).searchParams.get('__mh_path'))
					.toBe('studio/data/');
				await frame.evaluate(() => history.pushState({}, '', '/outside/?id=4'));
				await expect(page).toHaveURL(`${server.hostOrigin}/?id=4`);
			}
		});

		test('ignores unsafe shared paths and snapshots outside the sandbox base', async ({ page }) => {
			await page.goto(`${server.hostOrigin}/?__mh_path=..%2Fadmin`);
			const frame = await connectedFrame(page);
			expect(new URL(frame.url()).pathname).toBe(basePath);
			await expect(page).toHaveURL(`${server.hostOrigin}/`);
			if (basePath !== '/') {
				await frame.evaluate(() =>
					history.replaceState({}, '', '/hub/proxy/current-other/studio/?id=1'),
				);
				await expect(page).toHaveURL(`${server.hostOrigin}/?id=1`);
			}
		});
	});
}
