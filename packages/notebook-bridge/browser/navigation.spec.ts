import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { harness } from './harness';

let server: Awaited<ReturnType<typeof harness>>;
test.beforeAll(async () => {
	server = await harness();
});
test.afterAll(async () => {
	await server.close();
});

async function loadNotebook(page: Page, url = `${server.hostOrigin}/?navigation=1`) {
	await page.goto(url);
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	return page.frames().find((frame) => frame.parentFrame())!;
}

async function openTab(page: Page, activate: () => Promise<void>) {
	const opened = page.context().waitForEvent('page');
	await activate();
	const tab = await opened;
	await tab.bringToFront();
	return tab;
}

for (const behavior of ['reject', 'throw'] as const) {
	test(`recovers from a host that ${behavior}s navigation`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const frame = await loadNotebook(page);
		await frame.evaluate(() =>
			document.body.insertAdjacentHTML('beforeend', '<a href="/app/match?id=xyz">Match</a>'),
		);
		await page.evaluate((behavior) => {
			window.navigationBehavior = behavior;
		}, behavior);
		await frame.getByRole('link', { name: 'Match' }).click();
		await expect.poll(() => page.evaluate(() => window.navigationRequests)).toBe(1);
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		await frame.evaluate(() => history.replaceState({}, '', '?after=rejection'));
		await expect(page).toHaveURL(`${server.hostOrigin}/?after=rejection`);
		await page.evaluate(() => {
			window.navigationBehavior = 'accept';
		});
		await frame.getByRole('link', { name: 'Match' }).click();
		await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match?id=xyz`);
		expect(await page.evaluate(() => window.navigationRequests)).toBe(2);
		expect(errors).toEqual([]);
	});
}

for (const timeout of [false, true]) {
	test(`reconnects after losing the host during navigation (timeout: ${timeout})`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const frame = await loadNotebook(page);
		await frame.evaluate(() =>
			document.body.insertAdjacentHTML('beforeend', '<a href="/app/match?id=xyz">Match</a>'),
		);
		const link = frame.getByRole('link', { name: 'Match' });
		await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match?id=xyz`);
		await page.evaluate(() => window.bridge.dispose());
		await link.click();
		if (timeout) {
			await expect
				.poll(() => frame.evaluate(() => window.bridge.status), { timeout: 8000 })
				.toBe('unavailable');
			await expect(link).toHaveAttribute('href', '/app/match?id=xyz');
		}
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		await page.evaluate(() => window.connect());
		await expect.poll(() => page.evaluate(() => window.bridge.status)).toBe('connected');
		await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match?id=xyz`);
		await frame.evaluate(() => history.replaceState({}, '', '?after=reconnect'));
		await expect(page).toHaveURL(`${server.hostOrigin}/?after=reconnect`);
		await link.click();
		await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match?id=xyz`);
		expect(errors).toEqual([]);
	});
}

test('ignores double clicks and disposes safely while navigation is pending', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const frame = await loadNotebook(page);
	await frame.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/app/match?id=xyz';
		document.body.append(link);
		link.click();
		link.click();
	});
	await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match?id=xyz`);
	expect(await page.evaluate(() => window.navigationRequests)).toBe(1);
	await page.evaluate(() => window.connect());
	await expect.poll(() => page.evaluate(() => window.bridge.status)).toBe('connected');
	await page.evaluate(() => window.bridge.dispose());
	await frame.evaluate(() => {
		document.querySelector('a')!.click();
		window.bridge.dispose();
		window.bridge.dispose();
	});
	expect(await frame.evaluate(() => window.bridge.status)).toBe('disposed');
	expect(errors).toEqual([]);
});

for (const target of ['', '_self', '_SELF']) {
	test(`explicit target ${JSON.stringify(target)} overrides the base target`, async ({ page }) => {
		const frame = await loadNotebook(page);
		await frame.evaluate((target) => {
			document.head.insertAdjacentHTML('beforeend', '<base target="_blank">');
			const link = document.createElement('a');
			link.href = '/app/match';
			link.target = target;
			link.textContent = 'Match';
			document.body.append(link);
		}, target);
		await frame.getByRole('link', { name: 'Match' }).click();
		await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match`);
		expect(await page.evaluate(() => window.navigationRequests)).toBe(1);
	});
}

for (const target of ['anchor', 'base', 'named', 'middle', 'modified', 'script']) {
	test(`loads a COOP-protected app in a new tab (${target})`, async ({ page, browserName }) => {
		test.skip(
			browserName === 'webkit' && target === 'middle',
			'Playwright WebKit does not open a new tab on middle-click, even without a sandbox.',
		);
		const frame = await loadNotebook(page);
		await frame.evaluate((target) => {
			if (target === 'base')
				document.head.insertAdjacentHTML('beforeend', '<base target="_blank">');
			const link = document.createElement('a');
			link.href = '/app/match?id=xyz#section';
			link.textContent = 'Match';
			if (target === 'anchor' || target === 'script') link.target = '_blank';
			if (target === 'named') link.target = 'app-window';
			if (target === 'script') {
				link.addEventListener('click', (event) => {
					event.preventDefault();
					window.open(link.href, '_blank');
				});
			}
			document.body.append(link);
		}, target);
		await expect(frame.getByRole('link', { name: 'Match' })).toHaveAttribute(
			'href',
			`${server.hostOrigin}/prefix/app/match?id=xyz#section`,
		);
		const popup = await openTab(page, () =>
			frame.getByRole('link', { name: 'Match' }).click({
				button: target === 'middle' ? 'middle' : 'left',
				modifiers: target === 'modified' ? ['ControlOrMeta'] : [],
			}),
		);
		await expect(popup).toHaveURL(`${server.hostOrigin}/prefix/app/match?id=xyz#section`);
		await expect(popup.getByRole('heading', { name: 'Hub app' })).toBeVisible();
		expect(await popup.evaluate(() => window.opener === null)).toBe(true);
		await popup.close();
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		expect(await page.evaluate(() => window.navigationRequests)).toBe(0);
	});
}

test('follows an external redirect to a COOP-protected app without a navigation bridge', async ({
	page,
}) => {
	const destination = `${server.hostOrigin}/prefix/app/match?id=xyz#section`;
	const frame = await loadNotebook(page, server.hostOrigin);
	await frame.evaluate(() => {
		document.body.insertAdjacentHTML(
			'beforeend',
			'<a href="/redirect" target="_blank">Redirect</a>',
		);
	});
	const popup = await openTab(page, () => frame.getByRole('link', { name: 'Redirect' }).click());
	await expect(popup).toHaveURL(destination);
	await expect(popup.getByRole('heading', { name: 'Hub app' })).toBeVisible();
	expect(await popup.evaluate(() => window.opener === null)).toBe(true);
	await popup.close();
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
});

for (const status of [403, 404, 503]) {
	test(`loads a popup error response (${status}) and leaves the source notebook usable`, async ({
		page,
		context,
	}) => {
		await context.route(`${server.hostOrigin}/prefix/app/unavailable`, (route) =>
			route.fulfill({
				status,
				contentType: 'text/html',
				headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
				body: '<h1>App unavailable</h1>',
			}),
		);
		const frame = await loadNotebook(page);
		await frame.evaluate(() => {
			document.body.insertAdjacentHTML(
				'beforeend',
				'<a href="/app/unavailable" target="_blank">Unavailable</a><a href="/app/match">Match</a>',
			);
		});
		const link = frame.getByRole('link', { name: 'Unavailable' });
		await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/unavailable`);
		const popup = await openTab(page, () => link.click());
		await expect(popup.getByRole('heading', { name: 'App unavailable' })).toBeVisible();
		await popup.close();
		await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
		expect(await page.evaluate(() => window.navigationRequests)).toBe(0);
		await frame.evaluate(() => history.replaceState({}, '', '?after=popup-error'));
		await expect(page).toHaveURL(`${server.hostOrigin}/?after=popup-error`);
		await frame.getByRole('link', { name: 'Match' }).click();
		await expect(page).toHaveURL(`${server.hostOrigin}/prefix/app/match`);
	});
}

test('still blocks direct top-level navigation from the notebook after a user click', async ({
	page,
}) => {
	const frame = await loadNotebook(page);
	await frame.evaluate((destination) => {
		const button = document.createElement('button');
		button.textContent = 'Navigate top';
		button.onclick = () => {
			try {
				window.top!.location.href = destination;
				button.dataset.result = 'allowed';
			} catch (error) {
				button.dataset.result = (error as DOMException).name;
			}
		};
		document.body.append(button);
	}, `${server.hostOrigin}/prefix/app/match`);
	const button = frame.getByRole('button', { name: 'Navigate top' });
	await button.click();
	await expect(button).toHaveAttribute('data-result', 'SecurityError');
	await expect(page).toHaveURL(`${server.hostOrigin}/?early=observed`);
	await frame.evaluate(() => history.replaceState({}, '', '?after=blocked-navigation'));
	await expect(page).toHaveURL(`${server.hostOrigin}/?after=blocked-navigation`);
});

test('does not intercept cancelled clicks, downloads, named targets, or unrelated links', async ({
	page,
}) => {
	await page.addInitScript(() => {
		window.addEventListener(
			'click',
			(event) => {
				if ((event.target as Element)?.id === 'cancelled') event.preventDefault();
			},
			true,
		);
	});
	const frame = await loadNotebook(page);
	const results = await frame.evaluate(() => {
		const cases = [
			{ href: '/app/match', id: 'cancelled' },
			{ href: '/app/file', download: '' },
			{ href: '/app/match', target: 'named' },
			{ href: '/other' },
			{ href: '#section' },
			{ href: 'https://external.example/app/match' },
		];
		return cases.map((attributes) => {
			const link = document.createElement('a');
			for (const [key, value] of Object.entries(attributes)) link.setAttribute(key, value);
			document.body.append(link);
			let reached = false;
			let prevented = false;
			link.addEventListener('click', (event) => {
				reached = true;
				prevented = event.defaultPrevented;
				event.preventDefault();
			});
			link.click();
			return { reached, prevented };
		});
	});
	expect(results).toEqual([
		{ reached: true, prevented: true },
		...Array.from({ length: 5 }, () => ({ reached: true, prevented: false })),
	]);
	expect(await page.evaluate(() => window.navigationRequests)).toBe(0);
});

test('preserves application href changes and restores detached links', async ({ page }) => {
	const frame = await loadNotebook(page);
	await frame.evaluate(() =>
		document.body.insertAdjacentHTML(
			'beforeend',
			'<a href="/app/match">Match</a><a href="/app/other">Other</a>',
		),
	);
	const link = frame.getByRole('link', { name: 'Match' });
	await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match`);
	const handle = await link.elementHandle();
	await handle!.evaluate((anchor) => anchor.remove());
	await expect.poll(() => handle!.getAttribute('href')).toBe('/app/match');
	await handle!.evaluate((anchor) => document.body.append(anchor));
	await expect(link).toHaveAttribute('href', `${server.hostOrigin}/prefix/app/match`);
	await link.evaluate((anchor) => anchor.setAttribute('href', '/ordinary'));
	await frame
		.getByRole('link', { name: 'Other' })
		.evaluate((anchor) => anchor.removeAttribute('href'));
	await frame.evaluate(() => window.bridge.dispose());
	await expect(link).toHaveAttribute('href', '/ordinary');
	await expect(frame.getByText('Other', { exact: true })).not.toHaveAttribute('href');
});

test('does not rewrite removed descendants from queued mutations', async ({ page }) => {
	const frame = await loadNotebook(page);
	await frame.evaluate(() =>
		document.body.insertAdjacentHTML(
			'beforeend',
			'<div id="output"><a href="/app/match">Match</a></div>',
		),
	);
	await expect(frame.getByRole('link', { name: 'Match' })).toHaveAttribute(
		'href',
		`${server.hostOrigin}/prefix/app/match`,
	);
	const output = await frame.locator('#output').elementHandle();
	await output!.evaluate((element) => {
		element.remove();
		element.querySelector('a')!.setAttribute('href', '/app/changed');
		element.insertAdjacentHTML('beforeend', '<a href="/app/new">New</a>');
	});
	await expect
		.poll(() =>
			output!.evaluate((element) =>
				[...element.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
			),
		)
		.toEqual(['/app/changed', '/app/new']);
	await frame.evaluate(() => window.bridge.dispose());
	await output!.evaluate((element) => document.body.append(element));
	await expect(frame.getByRole('link', { name: 'Match' })).toHaveAttribute('href', '/app/changed');
	await expect(frame.getByRole('link', { name: 'New' })).toHaveAttribute('href', '/app/new');
});
