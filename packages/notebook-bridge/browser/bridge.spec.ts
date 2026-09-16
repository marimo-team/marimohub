import { expect, test } from '@playwright/test';
import { harness } from './harness';

let server: Awaited<ReturnType<typeof harness>>;
test.beforeAll(async () => {
	server = await harness();
});
test.afterAll(async () => {
	await server.close();
});

for (const delayed of [false, true]) {
	test(`mirrors early and repeated changes without reload (delayed host: ${delayed})`, async ({
		page,
	}) => {
		await page.goto(`${server.hostOrigin}/?delay=${delayed ? 1 : 0}#anchor`);
		await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('connected');
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed#anchor`);
		const frame = page.frames().find((f) => f.parentFrame())!;
		const loads = await page.evaluate(() => window.loads);
		await frame.evaluate(() => {
			for (let i = 0; i < 20; i++)
				history.pushState({}, '', `?id=${i}&tag=one&tag=two&empty=&provider=secret&theme=dark`);
		});
		await expect(page).toHaveURL(`${server.hostOrigin}/?id=19&tag=one&tag=two&empty=#anchor`);
		expect(await page.evaluate(() => window.loads)).toBe(loads);
		await frame.evaluate(() => history.replaceState({}, '', location.pathname));
		await expect(page).toHaveURL(`${server.hostOrigin}/#anchor`);
		expect(await page.evaluate(() => window.updates)).toBeLessThan(6);
	});
}

test('reconnects after reload and ignores stale ports and unrelated frames', async ({ page }) => {
	await page.goto(server.hostOrigin);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	const loads = await page.evaluate(() => window.loads);
	await frame.evaluate(() => location.reload());
	await expect.poll(() => page.evaluate(() => window.loads)).toBe(loads + 1);
	await expect.poll(() => page.evaluate(() => window.bridge.status)).toBe('connected');
	await frame.evaluate(() => history.replaceState({}, '', '?after=reload'));
	await expect(page).toHaveURL(`${server.hostOrigin}/?after=reload`);
	await page.evaluate(() => {
		window.postMessage(
			{
				namespace: 'marimohub.notebook-bridge',
				kind: 'ready',
				version: { major: 1, minor: 0 },
				capabilities: ['query-params.v1'],
				documentId: 'spoof',
			},
			location.origin,
		);
		window.bridge.dispose();
		window.bridge.dispose();
	});
	await frame.evaluate(() => history.replaceState({}, '', '?late=ignored'));
	await page.waitForTimeout(200);
	await expect(page).toHaveURL(`${server.hostOrigin}/?after=reload`);
	expect(await page.evaluate(() => window.bridge.status)).toBe('disposed');
});

test('rejects oversized snapshots, preserves History exceptions, and restores methods', async ({
	page,
}) => {
	await page.goto(server.hostOrigin);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	await frame.evaluate(() => history.replaceState({}, '', `?large=${'x'.repeat(70_000)}`));
	await page.waitForTimeout(200);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const result = await frame.evaluate(() => {
		let threw = false;
		try {
			history.pushState({}, '', 'https://invalid.example/');
		} catch {
			threw = true;
		}
		const wrapped = history.pushState;
		window.bridge.dispose();
		return { threw, restored: wrapped !== history.pushState };
	});
	expect(result).toEqual({ threw: true, restored: true });
});

test('keeps unsupported peers usable and stops connection attempts', async ({ page }) => {
	await page.goto(`${server.hostOrigin}/?child=${encodeURIComponent(`${server.childOrigin}/`)}`);
	await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('connected');
	await page.evaluate(() => window.bridge.dispose());
	const frame = page.frames().find((f) => f.parentFrame())!;
	await frame.evaluate(() => window.bridge.dispose());
	await page.evaluate(() => window.connect());
	await expect
		.poll(() => page.evaluate(() => window.bridge.status), { timeout: 15_000 })
		.toBe('unavailable');
	await expect(page.locator('iframe')).toBeVisible();
});

test('observes native history traversal and ignores a second notebook frame', async ({ page }) => {
	await page.goto(server.hostOrigin);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	await page.evaluate((source) => {
		const second = document.createElement('iframe');
		second.src = source;
		document.body.append(second);
	}, `${server.childOrigin}/?other=ignored`);
	const second = page.frames().filter((f) => f.parentFrame())[1];
	await second.waitForURL(`${server.childOrigin}/**`);
	await frame.evaluate(() => {
		history.pushState({ first: true }, '', '?first=1');
		history.pushState({ second: true }, '', '?second=2');
	});
	await expect(page).toHaveURL(`${server.hostOrigin}/?second=2`);
	await frame.evaluate(() => history.back());
	await expect(page).toHaveURL(`${server.hostOrigin}/?first=1`);
	expect(await frame.evaluate(() => history.state)).toEqual({ first: true });
	await second.evaluate(() => history.replaceState({}, '', '?spoof=ignored'));
	await page.waitForTimeout(200);
	await expect(page).toHaveURL(`${server.hostOrigin}/?first=1`);
});

test('disables incompatible major versions without removing the notebook', async ({ page }) => {
	await page.goto(
		`${server.hostOrigin}/?child=${encodeURIComponent(`${server.childOrigin}/incompatible`)}`,
	);
	await expect.poll(() => page.evaluate(() => window.bridge?.status)).toBe('unavailable');
	await expect(page.frameLocator('iframe').getByText('Unsupported notebook')).toBeVisible();
});

test('falls back without browser errors when MessageChannel is unavailable', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => {
		if (window === parent) Object.defineProperty(window, 'MessageChannel', { value: undefined });
	});
	await page.goto(server.hostOrigin);
	await expect
		.poll(() => page.evaluate(() => window.bridge?.status), { timeout: 1500 })
		.toBe('unavailable');
	await expect(page.frameLocator('iframe').getByText('Notebook', { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test('recovers after a host disappears with a query request pending', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(server.hostOrigin);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	const loads = await page.evaluate(() => window.loads);
	await page.evaluate(() => window.bridge.dispose());
	await frame.evaluate(() => history.replaceState({}, '', '?recover=latest'));
	await expect
		.poll(() => frame.evaluate(() => window.bridge.status), { timeout: 8000 })
		.toBe('unavailable');
	await page.evaluate(() => window.connect());
	await expect(page).toHaveURL(`${server.hostOrigin}/?recover=latest`);
	expect(await page.evaluate(() => window.loads)).toBe(loads);
	expect(errors).toEqual([]);
});

test('preserves native History arguments, serialization errors, and third-party wrappers', async ({
	page,
}) => {
	await page.goto(server.hostOrigin);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	const result = await frame.evaluate(() => {
		const state = { nested: { label: 'kept' }, list: [1, 2] };
		const returned = history.pushState(state, 'title', '?native=1');
		const before = location.href;
		let errorName = '';
		try {
			history.replaceState(() => {}, '', '?must-not-apply=1');
		} catch (error) {
			errorName = (error as Error).name;
		}
		const bridgeWrapper = history.pushState;
		const thirdParty: History['pushState'] = function (this: History, ...args) {
			return bridgeWrapper.apply(this, args);
		};
		history.pushState = thirdParty;
		window.bridge.dispose();
		return {
			returnIsUndefined: returned === undefined,
			state: history.state,
			preservedUrl: before === location.href,
			errorName,
			keptThirdParty: history.pushState === thirdParty,
		};
	});
	expect(result).toEqual({
		returnIsUndefined: true,
		state: { nested: { label: 'kept' }, list: [1, 2] },
		preservedUrl: true,
		errorName: 'DataCloneError',
		keptThirdParty: true,
	});
	await page.waitForTimeout(200);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
});
