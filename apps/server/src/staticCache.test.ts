import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
	cacheControlForStaticPath,
	IMMUTABLE_ASSET_CACHE_CONTROL,
	REVALIDATE_STATIC_CACHE_CONTROL,
	serveStaticWithCache,
} from './staticCache';

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

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
		writeFileSync(join(root, 'index.html'), '<!doctype html>');
		writeFileSync(join(root, 'assets', 'index-C8a1b2.js'), 'console.log(1);');

		const app = new Hono();
		app.use('/*', serveStaticWithCache({ root }));
		app.get('*', serveStaticWithCache({ path: join(root, 'index.html') }));

		expect((await app.request('/')).headers.get('Cache-Control')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
		expect((await app.request('/projects/acme')).headers.get('Cache-Control')).toBe(
			REVALIDATE_STATIC_CACHE_CONTROL,
		);
		expect((await app.request('/assets/index-C8a1b2.js')).headers.get('Cache-Control')).toBe(
			IMMUTABLE_ASSET_CACHE_CONTROL,
		);

		const missingAssetApp = new Hono();
		missingAssetApp.use('/*', serveStaticWithCache({ root }));
		expect((await missingAssetApp.request('/missing.js')).status).toBe(404);
	});
});
