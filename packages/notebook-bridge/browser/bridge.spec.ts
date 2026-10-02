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
	await page.evaluate(async () => {
		const delivered = new Promise<void>((resolve) => {
			const onMessage = (event: MessageEvent) => {
				if (event.data?.documentId !== 'spoof') return;
				removeEventListener('message', onMessage);
				setTimeout(resolve, 0);
			};
			addEventListener('message', onMessage);
		});
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
		await delivered;
	});
	expect(await page.evaluate(() => window.bridge.status)).toBe('connected');
	await frame.evaluate(() => history.replaceState({}, '', '?after=spoof'));
	await expect(page).toHaveURL(`${server.hostOrigin}/?after=spoof`);
	await page.evaluate(() => {
		window.bridge.dispose();
		window.bridge.dispose();
	});
	await frame.evaluate(() => history.replaceState({}, '', '?late=ignored'));
	await page.waitForTimeout(200);
	await expect(page).toHaveURL(`${server.hostOrigin}/?after=spoof`);
	expect(await page.evaluate(() => window.bridge.status)).toBe('disposed');
});

test('preserves Hub and provider query values when notebook parameters change or clear', async ({
	page,
}) => {
	await page.goto(
		`${server.hostOrigin}/prefix?theme=light&theme=system&provider=trusted&obsolete=1#anchor`,
	);
	await expect(page).toHaveURL(
		`${server.hostOrigin}/prefix?theme=light&theme=system&provider=trusted&early=observed#anchor`,
	);
	const frame = page.frames().find((f) => f.parentFrame())!;
	await frame.evaluate(() =>
		history.replaceState({}, '', '?theme=dark&provider=untrusted&tag=one&tag=two&empty='),
	);
	await expect(page).toHaveURL(
		`${server.hostOrigin}/prefix?theme=light&theme=system&provider=trusted&tag=one&tag=two&empty=#anchor`,
	);
	await frame.evaluate(() => history.replaceState({}, '', location.pathname));
	await expect(page).toHaveURL(
		`${server.hostOrigin}/prefix?theme=light&theme=system&provider=trusted#anchor`,
	);
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

for (const href of ['/app/team/match', 'app/team/match']) {
	test(`routes dynamic ${href} links through the parent and fences old updates`, async ({
		page,
	}) => {
		await page.goto(`${server.hostOrigin}/?navigation=1`);
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		const frame = page.frames().find((f) => f.parentFrame())!;
		const loads = await page.evaluate(() => window.loads);
		await frame.evaluate((href) => {
			const anchor = document.createElement('a');
			anchor.href = `${href}?id=xyz&tag=a&tag=b&provider=secret&access_token=secret#result`;
			anchor.innerHTML = '<span>Other app</span>';
			document.body.append(anchor);
		}, href);
		const link = frame.getByRole('link', { name: 'Other app' });
		await expect(link).toHaveAttribute(
			'href',
			`${server.hostOrigin}/prefix/app/team/match?id=xyz&tag=a&tag=b#result`,
		);
		await link.getByText('Other app').click();
		await expect(page).toHaveURL(
			`${server.hostOrigin}/prefix/app/team/match?id=xyz&tag=a&tag=b#result`,
		);
		await frame.evaluate(() => history.replaceState({}, '', '?stale=ignored'));
		await page.waitForTimeout(250);
		await expect(page).toHaveURL(
			`${server.hostOrigin}/prefix/app/team/match?id=xyz&tag=a&tag=b#result`,
		);
		expect(await page.evaluate(() => window.loads)).toBe(loads);
	});
}

test('preserves native new-tab navigation and restores owned hrefs on disposal', async ({
	page,
}) => {
	await page.goto(`${server.hostOrigin}/?navigation=1`);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	await frame.evaluate(() => {
		document.body.insertAdjacentHTML(
			'beforeend',
			'<a href="/app/match?id=xyz" target="_blank">New tab</a><a href="/app/original">Mutable</a><a href="/app/download" download>Download</a><a href="/other">Other</a>',
		);
	});
	const link = frame.getByRole('link', { name: 'New tab' });
	await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match?id=xyz`);
	await expect(frame.getByRole('link', { name: 'Download' })).toHaveAttribute(
		'href',
		'/app/download',
	);
	await expect(frame.getByRole('link', { name: 'Other', exact: true })).toHaveAttribute(
		'href',
		'/other',
	);
	const popupPromise = page.waitForEvent('popup');
	await link.click();
	const popup = await popupPromise;
	await popup.waitForURL(`${server.hostOrigin}/prefix/app/match?id=xyz`);
	await popup.close();
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	await frame
		.getByRole('link', { name: 'Mutable' })
		.evaluate((anchor) => anchor.setAttribute('href', '/app/replaced?id=new'));
	await expect(frame.getByRole('link', { name: 'Mutable' })).toHaveAttribute(
		'href',
		`${server.hostOrigin}/prefix/app/replaced?id=new`,
	);
	await frame.evaluate(() => window.bridge.dispose());
	await expect(link).toHaveAttribute('href', '/app/match?id=xyz');
	await expect(frame.getByRole('link', { name: 'Mutable' })).toHaveAttribute(
		'href',
		'/app/replaced?id=new',
	);
});

test('leaves app links unchanged without negotiated navigation', async ({ page }) => {
	await page.goto(server.hostOrigin);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	await frame.evaluate(() =>
		document.body.insertAdjacentHTML('beforeend', '<a href="/app/match">Other app</a>'),
	);
	await expect(frame.getByRole('link', { name: 'Other app' })).toHaveAttribute(
		'href',
		'/app/match',
	);
});

for (const gesture of ['keyboard', 'modified', 'middle'] as const) {
	test(`supports ${gesture} activation of app links`, async ({ page }) => {
		await page.goto(`${server.hostOrigin}/?navigation=1`);
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		const frame = page.frames().find((f) => f.parentFrame())!;
		await frame.evaluate(() =>
			document.body.insertAdjacentHTML('beforeend', '<a href="/app/match?id=xyz">Match</a>'),
		);
		const link = frame.getByRole('link', { name: 'Match', exact: true });
		await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match?id=xyz`);
		if (gesture === 'keyboard') {
			await link.focus();
			await page.keyboard.press('Enter');
			await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match?id=xyz`);
		} else {
			const prevented = await link.evaluate((anchor, gesture) => {
				let prevented: boolean | undefined;
				const type = gesture === 'middle' ? 'auxclick' : 'click';
				anchor.addEventListener(
					type,
					(event) => {
						prevented = event.defaultPrevented;
						event.preventDefault();
					},
					{ once: true },
				);
				anchor.dispatchEvent(
					new MouseEvent(type, {
						bubbles: true,
						composed: true,
						cancelable: true,
						button: gesture === 'middle' ? 1 : 0,
						ctrlKey: gesture === 'modified',
					}),
				);
				return prevented;
			}, gesture);
			expect(prevented).toBe(false);
			await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		}
	});
}

test('leaves resource hrefs alone and restores links changed to downloads', async ({ page }) => {
	await page.goto(`${server.hostOrigin}/?navigation=1`);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	const frame = page.frames().find((f) => f.parentFrame())!;
	await frame.evaluate(() => {
		document.body.insertAdjacentHTML('beforeend', '<a href="/app/match">Match</a>');
		const resource = document.createElement('link');
		resource.id = 'resource';
		document.head.append(resource);
		resource.href = '/app/resource';
	});
	const link = frame.getByRole('link', { name: 'Match' });
	await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match`);
	await expect(frame.locator('#resource')).toHaveAttribute('href', '/app/resource');
	await link.evaluate((anchor) => anchor.setAttribute('download', ''));
	await expect(link).toHaveAttribute('href', '/app/match');
	await link.evaluate((anchor) => anchor.removeAttribute('download'));
	await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match`);
});

for (const late of [false, true]) {
	test(`rewrites nested shadow links and cleans up removed outputs (late root: ${late})`, async ({
		page,
	}) => {
		await page.goto(`${server.hostOrigin}/?navigation=1`);
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		const frame = page.frames().find((f) => f.parentFrame())!;
		await frame.evaluate((late) => {
			const host = document.createElement('div');
			host.id = 'shadow-host';
			if (late) document.body.append(host);
			const root = host.attachShadow({ mode: 'open' });
			const nested = document.createElement('div');
			root.append(nested);
			nested.attachShadow({ mode: 'open' }).innerHTML =
				'<a href="/app/match?id=xyz"><span>Shadow app</span></a>';
			if (!late) document.body.append(host);
		}, late);
		const link = frame.getByRole('link', { name: 'Shadow app' });
		await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match?id=xyz`);
		const host = await frame.locator('#shadow-host').elementHandle();
		await host!.evaluate((element) => element.remove());
		await expect
			.poll(() =>
				host!.evaluate((element) =>
					element
						.shadowRoot!.querySelector('div')!
						.shadowRoot!.querySelector('a')!
						.getAttribute('href'),
				),
			)
			.toBe('/app/match?id=xyz');
		await host!.evaluate((element) => document.body.append(element));
		await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match?id=xyz`);
		await link.click();
		await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match?id=xyz`);
		await frame.evaluate(() => {
			const previous = Element.prototype.attachShadow;
			const wrapper: Element['attachShadow'] = function (this: Element, options) {
				return previous.call(this, options);
			};
			Element.prototype.attachShadow = wrapper;
			window.bridge.dispose();
			if (Element.prototype.attachShadow !== wrapper) throw new Error('Lost third-party wrapper');
			const host = document.createElement('div');
			document.body.append(host);
			host.attachShadow({ mode: 'open' }).innerHTML = '<a href="/app/after">After disposal</a>';
		});
		await expect(link).toHaveAttribute('href', '/app/match?id=xyz');
		await expect(frame.getByRole('link', { name: 'After disposal' })).toHaveAttribute(
			'href',
			'/app/after',
		);
	});
}

for (const delayed of [false, true]) {
	test(`mirrors title mutations and cleans up observers (delayed host: ${delayed})`, async ({
		page,
	}) => {
		await page.goto(`${server.hostOrigin}/?delay=${delayed ? 1 : 0}`);
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		await page.waitForTimeout(200);
		await expect(page).toHaveTitle('Hub notebook title');
		const frame = page.frames().find((f) => f.parentFrame())!;
		const loads = await page.evaluate(() => window.loads);
		const updates = await page.evaluate(() => window.updates);
		await frame.evaluate(() => {
			document.title = 'Live forecast';
		});
		await expect(page).toHaveTitle('Live forecast');
		await frame.evaluate(() => {
			document.querySelector('title')!.firstChild!.textContent = 'Text mutation';
		});
		await expect(page).toHaveTitle('Text mutation');
		await frame.evaluate(() => {
			const title = document.createElement('title');
			title.textContent = 'Replacement';
			document.querySelector('title')!.replaceWith(title);
		});
		await expect(page).toHaveTitle('Replacement');
		await frame.evaluate(() => {
			document.querySelector('title')!.remove();
		});
		await expect(page).toHaveTitle('');
		await frame.evaluate(() => {
			document.title = 'Recreated';
		});
		await expect(page).toHaveTitle('Recreated');
		expect(await page.evaluate(() => window.loads)).toBe(loads);
		expect(await page.evaluate(() => window.updates)).toBe(updates);
		await frame.evaluate(() => {
			window.bridge.dispose();
			document.title = 'Ignored';
		});
		await page.waitForTimeout(200);
		await expect(page).toHaveTitle('Recreated');
	});
}
