import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createTestApi, expectError, makeTestDeps } from '../testing';

describe('installation metadata', () => {
	it('serves defaults before sign-in without accessing identity or storage', async () => {
		const bucket = new MemoryBucket();
		const get = vi.spyOn(bucket, 'get').mockRejectedValue(new Error('Storage unavailable'));
		const authenticate = vi.fn().mockRejectedValue(new Error('Identity provider unavailable'));
		const { app } = createTestApi({ bucket, deps: { authenticator: { authenticate } } });
		const response = await app.request('/manifest.webmanifest');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/manifest+json');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			id: '/',
			name: 'marimohub',
			short_name: 'marimohub',
			start_url: '/',
			scope: '/',
			display: 'standalone',
			theme_color: '#0d9488',
			icons: [
				{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
				{
					src: '/icons/icon-512.png',
					sizes: '512x512',
					type: 'image/png',
					purpose: 'any maskable',
				},
			],
		});
		const icon = await app.request('/apple-touch-icon.png');
		expect(icon.status).toBe(302);
		expect(icon.headers.get('location')).toBe('/icons/apple-touch-icon.png');
		expect(icon.headers.get('cache-control')).toBe('no-store');
		expect(authenticate).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});

	it.each(['https://hub.example.com/tools/hub', 'https://hub.example.com/tools/hub/'])(
		'keeps all default URLs and installation identity under %s',
		async (appBaseUrl) => {
			const { app } = createTestApi({
				deps: { sandbox: { ...makeTestDeps(new MemoryBucket()).sandbox, appBaseUrl } },
			});
			const manifest = await (await app.request('/manifest.webmanifest')).json();
			expect(manifest).toMatchObject({
				id: '/tools/hub/',
				start_url: '/tools/hub/',
				scope: '/tools/hub/',
			});
			expect(manifest).toMatchObject({
				icons: [{ src: '/tools/hub/icons/icon-192.png' }, { src: '/tools/hub/icons/icon-512.png' }],
				shortcuts: [{ url: '/tools/hub/projects' }, { url: '/tools/hub/apps' }],
			});
			expect((await app.request('/apple-touch-icon.png')).headers.get('location')).toBe(
				'/tools/hub/icons/apple-touch-icon.png',
			);
		},
	);

	it('uses dedicated icons without rewriting asset paths or guessing maskable support', async () => {
		const { app } = createTestApi({
			deps: {
				sandbox: {
					...makeTestDeps(new MemoryBucket()).sandbox,
					appBaseUrl: 'https://hub.example.com/hub/',
				},
				theme: {
					...DEFAULT_THEME_CONFIG,
					name: 'Research Hub',
					primary_color: '#ABC',
					favicon: '/favicon.ico',
					logo: '/wide-logo.svg',
					pwa_icon_192: '/brand/192.png',
					pwa_icon_512: 'https://cdn.example.com/512.png?v=2',
					apple_touch_icon: '/brand/apple.png',
				},
			},
		});
		const manifest = await (await app.request('/manifest.webmanifest')).json();
		expect(manifest).toMatchObject({
			name: 'Research Hub',
			short_name: 'Research Hub',
			theme_color: '#ABC',
			icons: [
				{ src: '/brand/192.png', purpose: 'any' },
				{ src: 'https://cdn.example.com/512.png?v=2', purpose: 'any' },
			],
		});
		expect((await app.request('/apple-touch-icon.png')).headers.get('location')).toBe(
			'/brand/apple.png',
		);
	});

	it('preserves identity across branding changes and isolates concurrent deployments', async () => {
		const first = createTestApi({
			deps: {
				theme: {
					...DEFAULT_THEME_CONFIG,
					name: 'First',
					primary_color: '#f00',
					pwa_icon_192: '/custom.png',
				},
			},
		});
		const second = createTestApi({
			deps: { theme: { ...DEFAULT_THEME_CONFIG, name: 'Second', primary_color: '#00f' } },
		});
		const [a, b] = await Promise.all([
			first.app.request('/manifest.webmanifest'),
			second.app.request('/manifest.webmanifest'),
		]);
		const firstManifest = await a.json();
		const secondManifest = await b.json();
		expect(firstManifest).toMatchObject({
			name: 'First',
			theme_color: '#f00',
			icons: [{ src: '/custom.png' }, { src: '/icons/icon-512.png' }],
		});
		expect(secondManifest).toMatchObject({
			name: 'Second',
			theme_color: '#00f',
			icons: [{ src: '/icons/icon-192.png' }, { src: '/icons/icon-512.png' }],
		});
		expect(firstManifest).toMatchObject({ id: '/', start_url: '/' });
		expect(secondManifest).toMatchObject({ id: '/', start_url: '/' });
	});

	it.each(['/manifest.webmanifest', '/apple-touch-icon.png'])(
		'rejects invalid branding at %s without exposing its value',
		async (path) => {
			const { app } = createTestApi({
				deps: {
					theme: {
						...DEFAULT_THEME_CONFIG,
						apple_touch_icon: 'https://private:secret@example.com/icon.png',
					},
				},
			});
			const response = await app.request(path);
			const body = await expectError(response, 500, 'INTERNAL_ERROR');
			expect(JSON.stringify(body)).not.toContain('private:secret');
		},
	);
});
