import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
	cacheControlForStaticPath,
	IMMUTABLE_ASSET_CACHE_CONTROL,
	injectAppBaseHref,
	REVALIDATE_STATIC_CACHE_CONTROL,
	serveSpaFallback,
	serveStaticWithCache,
} from './staticCache';

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function staticApp(appBaseUrl?: string, indexHtml = '<!doctype html><base href="/" />'): Hono {
	const root = mkdtempSync(join(tmpdir(), 'marimohub-static-'));
	temporaryRoots.push(root);
	writeFileSync(join(root, 'index.html'), indexHtml);
	const app = new Hono();
	app.get('*', serveSpaFallback(root, appBaseUrl));
	return app;
}

describe('cacheControlForStaticPath', () => {
	it('revalidates the HTML shell', () => {
		expect(cacheControlForStaticPath('/app/public/index.html')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
		expect(cacheControlForStaticPath('/app/public/projects/acme')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
	});

	it('revalidates stable public files', () => {
		expect(cacheControlForStaticPath('/app/public/favicon.svg')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
	});

	it('caches fingerprinted assets for the URL lifetime', () => {
		expect(cacheControlForStaticPath('/app/public/assets/index-C8a1b2.js')).toBe(
			IMMUTABLE_ASSET_CACHE_CONTROL,
		);
		expect(cacheControlForStaticPath('C:\\app\\public\\assets\\index-C8a1b2.css')).toBe(
			IMMUTABLE_ASSET_CACHE_CONTROL,
		);
	});

	it('applies the policy to static responses and SPA fallbacks', async () => {
		const root = mkdtempSync(join(tmpdir(), 'marimohub-static-'));
		temporaryRoots.push(root);
		mkdirSync(join(root, 'assets'));
		writeFileSync(join(root, 'index.html'), '<!doctype html><base href="/" />');
		writeFileSync(join(root, 'assets', 'index-C8a1b2.js'), 'console.log(1);');

		const app = new Hono();
		const spaFallback = serveSpaFallback(root, 'https://hub.example.com/marimohub');
		app.get('/', spaFallback);
		app.get('/index.html', spaFallback);
		app.use('/*', serveStaticWithCache({ root }));
		app.get('*', spaFallback);

		expect((await app.request('/')).headers.get('Cache-Control')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
		expect((await app.request('/projects/acme')).headers.get('Cache-Control')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
		expect(await (await app.request('/')).text()).toContain('<base href="/marimohub/" />');
		expect(await (await app.request('/projects/acme')).text()).toContain(
			'<base href="/marimohub/" />',
		);
		const head = await app.request('/', { method: 'HEAD' });
		expect(head.headers.get('Content-Length')).toBeNull();
		expect(await head.text()).toBe('');
		expect((await app.request('/assets/index-C8a1b2.js')).headers.get('Cache-Control')).toBe(
			IMMUTABLE_ASSET_CACHE_CONTROL,
		);

		const missingAsset = await app.request('/assets/missing.js');
		expect(missingAsset.status).toBe(404);
		expect(missingAsset.headers.get('Cache-Control')).not.toBe(IMMUTABLE_ASSET_CACHE_CONTROL);

		const invalidRange = await app.request('/assets/index-C8a1b2.js', {
			headers: { Range: 'bytes=999-' },
		});
		expect(invalidRange.status).toBe(416);
		expect(invalidRange.headers.get('Cache-Control')).toBe(REVALIDATE_STATIC_CACHE_CONTROL);
	});
});

describe('serveSpaFallback', () => {
	it.each([
		[undefined, '/'],
		['', '/'],
		['   ', '/'],
		['https://hub.example.com', '/'],
		['https://hub.example.com/marimohub', '/marimohub/'],
		['https://hub.example.com/marimohub/', '/marimohub/'],
		['https://hub.example.com/marimohub///?ignored=1#ignored', '/marimohub/'],
	] as const)('injects exactly one trailing slash for %j', async (appBaseUrl, expected) => {
		const response = await staticApp(appBaseUrl).request('/projects/project-1');

		expect(response.status).toBe(200);
		expect(await response.text()).toContain(`<base href="${expected}" />`);
	});

	it('returns 404 when the SPA shell is missing', async () => {
		const root = mkdtempSync(join(tmpdir(), 'marimohub-static-'));
		temporaryRoots.push(root);
		const app = new Hono();
		app.get('*', serveSpaFallback(root, 'https://hub.example.com/marimohub/'));

		expect((await app.request('/projects/project-1')).status).toBe(404);
	});

	it('rejects an invalid configured URL before serving requests', () => {
		expect(() => serveSpaFallback('/tmp/static', '/relative')).toThrow(TypeError);
	});
});

describe('injectAppBaseHref', () => {
	it('replaces the build-time root marker', () => {
		expect(injectAppBaseHref('<head><base href="/" /></head>', '/marimohub/')).toBe(
			'<head><base href="/marimohub/" /></head>',
		);
		expect(injectAppBaseHref("<BASE href='/'></BASE>", '/marimohub/')).toBe(
			'<base href="/marimohub/" /></BASE>',
		);
	});

	it('escapes the injected attribute value', () => {
		expect(injectAppBaseHref('<base href="/">', '/team&"<>/')).toBe(
			'<base href="/team&amp;&quot;&lt;&gt;/" />',
		);
	});

	it.each([
		['a shell without a marker', '<head></head>'],
		['a shell with an already rewritten marker', '<base href="/marimohub/" />'],
		['a shell with duplicate markers', '<base href="/" /><base href="/" />'],
	])('rejects %s', (_case, html) => {
		expect(() => injectAppBaseHref(html, '/marimohub/')).toThrow(
			'exactly one <base href="/" /> marker',
		);
	});
});
