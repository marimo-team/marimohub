import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { applyThemeConfig, applyThemeMode, getInitialTheme, loadThemeConfig } from './theme';
import { installMatchMedia, jsonOk } from '@/test/render';

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
	document.head.innerHTML = '';
	document.documentElement.removeAttribute('data-custom-theme');
	document.documentElement.classList.remove('dark');
	document.documentElement.style.removeProperty('color-scheme');
});

describe('theme bootstrap', () => {
	it('loads public branding once under the deployment base path', async () => {
		document.head.innerHTML = '<base href="/hub/" />';
		const branding = { ...DEFAULT_THEME_CONFIG, name: 'Research Hub', logo: '/brand.svg' };
		const fetchMock = vi.fn().mockResolvedValue(jsonOk(branding));
		vi.stubGlobal('fetch', fetchMock);
		expect(await loadThemeConfig()).toEqual(branding);
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			'/hub/api/v1/theme',
			expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
		);
	});

	it.each([
		new Response('unavailable', { status: 503 }),
		new Response('login required', { status: 401 }),
		new Response('older server', { status: 404 }),
		new Response(null, { status: 204 }),
		jsonOk(null),
		jsonOk([]),
		jsonOk({ ...DEFAULT_THEME_CONFIG, name: '   ' }),
		jsonOk({ ...DEFAULT_THEME_CONFIG, name: 42 }),
		jsonOk({ ...DEFAULT_THEME_CONFIG, favicon: '//example.com/icon.svg' }),
		jsonOk({ ...DEFAULT_THEME_CONFIG, logo_dark: 'data:image/svg+xml,<svg/>' }),
		jsonOk({ ...DEFAULT_THEME_CONFIG, secondary_color: '#abcd' }),
		new Response(JSON.stringify({ success: false, data: DEFAULT_THEME_CONFIG })),
		new Response('not json'),
		jsonOk({ name: 'incomplete' }),
		jsonOk({ ...DEFAULT_THEME_CONFIG, logo: 'javascript:alert(1)' }),
		jsonOk({ ...DEFAULT_THEME_CONFIG, primary_color: 'red' }),
	])('uses defaults for an invalid response (%#)', async (response) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
		expect(await loadThemeConfig()).toEqual(DEFAULT_THEME_CONFIG);
	});

	it('uses defaults on network failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
		expect(await loadThemeConfig()).toEqual(DEFAULT_THEME_CONFIG);
	});

	it('aborts after two seconds, including a stalled response body', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
		vi.stubGlobal('fetch', fetchMock);
		const pending = loadThemeConfig();
		await vi.advanceTimersByTimeAsync(2000);
		expect(await pending).toEqual(DEFAULT_THEME_CONFIG);
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
	});

	it('preserves saved mode and falls back to the OS if storage is unavailable', () => {
		installMatchMedia(true);
		localStorage.setItem('marimohub-theme', 'light');
		expect(getInitialTheme()).toBe('light');
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('disabled');
		});
		expect(getInitialTheme()).toBe('dark');
	});

	it('applies both palettes, mode, title, and PNG favicon before React mounts', () => {
		document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />';
		applyThemeMode('dark');
		applyThemeConfig({
			...DEFAULT_THEME_CONFIG,
			name: 'Research Hub',
			primary_color: '#2563eb',
			favicon: '/brand/favicon.png',
		});
		expect(document.title).toBe('Research Hub');
		expect(document.documentElement).toHaveClass('dark');
		expect(document.documentElement.style.colorScheme).toBe('dark');
		const style = document.getElementById('deployment-theme');
		expect(style?.textContent).toContain(':root.dark');
		expect(style?.textContent).toContain('--primary:');
		const icon = document.querySelector('link[rel="icon"]');
		expect(icon).toHaveAttribute('href', '/brand/favicon.png');
		expect(icon).not.toHaveAttribute('type');
		applyThemeMode('light');
		expect(document.documentElement).not.toHaveClass('dark');
		expect(document.getElementById('deployment-theme')).toBe(style);
	});

	it('leaves stock CSS and favicon intact for name-only branding', () => {
		document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />';
		applyThemeConfig({ ...DEFAULT_THEME_CONFIG, name: 'Research Hub' });
		expect(document.getElementById('deployment-theme')).toBeNull();
		expect(document.documentElement).not.toHaveAttribute('data-custom-theme');
		expect(document.querySelector('link[rel="icon"]')).toHaveAttribute('href', './favicon.svg');
	});
	it('aborts a stalled connection and ignores a late response after the deadline', async () => {
		vi.useFakeTimers();
		const late = deferredResponse();
		const fetchMock = vi
			.fn()
			.mockReturnValueOnce(late.promise)
			.mockResolvedValueOnce(jsonOk({ ...DEFAULT_THEME_CONFIG, name: 'Recovered hub' }));
		vi.stubGlobal('fetch', fetchMock);
		const pending = loadThemeConfig();
		await vi.advanceTimersByTimeAsync(1999);
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toEqual(DEFAULT_THEME_CONFIG);
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
		late.resolve(jsonOk({ ...DEFAULT_THEME_CONFIG, name: 'Late hub' }));
		expect(await pending).toEqual(DEFAULT_THEME_CONFIG);
		expect((await loadThemeConfig()).name).toBe('Recovered hub');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('accepts a response just before the deadline and cancels its abort timer', async () => {
		vi.useFakeTimers();
		const deferred = deferredResponse();
		const fetchMock = vi.fn().mockReturnValue(deferred.promise);
		vi.stubGlobal('fetch', fetchMock);
		const pending = loadThemeConfig();
		await vi.advanceTimersByTimeAsync(1999);
		deferred.resolve(jsonOk({ ...DEFAULT_THEME_CONFIG, name: 'On time' }));
		expect((await pending).name).toBe('On time');
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cleans up the deadline when reading the response body fails', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.reject(new Error('Connection closed during download')),
			}),
		);
		expect(await loadThemeConfig()).toEqual(DEFAULT_THEME_CONFIG);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not prepend the hub base path to root-relative assets', () => {
		document.head.innerHTML = '<base href="/nested/hub/" />';
		applyThemeConfig({ ...DEFAULT_THEME_CONFIG, favicon: '/brand/icon.ico' });
		const icons = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
		expect(icons).toHaveLength(1);
		expect(new URL(icons[0].href).pathname).toBe('/brand/icon.ico');
	});

	it('replaces existing theme styles and favicon without accumulating duplicate elements', () => {
		applyThemeConfig({ ...DEFAULT_THEME_CONFIG, primary_color: '#f00', favicon: '/red.svg' });
		const initialCss = document.getElementById('deployment-theme')?.textContent;
		applyThemeConfig({ ...DEFAULT_THEME_CONFIG, primary_color: '#00f', favicon: '/blue.png' });
		expect(document.querySelectorAll('#deployment-theme')).toHaveLength(1);
		expect(document.getElementById('deployment-theme')?.textContent).not.toBe(initialCss);
		expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
		expect(document.querySelector('link[rel="icon"]')).toHaveAttribute('href', '/blue.png');
		applyThemeConfig(DEFAULT_THEME_CONFIG);
		expect(document.getElementById('deployment-theme')).toBeNull();
		expect(document.documentElement).not.toHaveAttribute('data-custom-theme');
	});
});
