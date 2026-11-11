import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';
import { MARIMO_VERSION_PATTERN } from '@marimo-hub/core/url';
import {
	MARIMO_RELEASE_VERSION,
	stageMarimoAssets,
} from '../../../scripts/stage-marimo-assets.mjs';
import { serveMarimoAssets } from './marimoAssets';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'marimo-assets-'));
	roots.push(root);
	const source = join(root, 'source');
	const target = join(root, 'public');
	mkdirSync(join(source, 'assets'), { recursive: true });
	writeFileSync(
		join(source, 'index.html'),
		'<script type="module" src="./assets/index-abcdef12.js"></script>',
	);
	const code = 'console.log("marimo");'.repeat(100);
	writeFileSync(join(source, 'assets/index-abcdef12.js'), code);
	writeFileSync(join(source, 'INDEX.HTM'), '<p>marimo</p>');
	writeFileSync(join(source, 'config.json'), '{}');
	const stage = () =>
		stageMarimoAssets({ sourceRoot: source, version: '0.25.2', staticRoot: target });
	const app = new Hono()
		.use('/_marimo/*', serveMarimoAssets(target))
		.get('*', (c) => c.html('SPA fallback'));
	return { source, target, code, stage, app };
}

it.each(['br', 'gzip'])(
	'serves a staged %s asset with immutable versioned caching and CORS',
	async (encoding) => {
		const { stage, app, code } = fixture();
		stage();
		const response = await app.request('/_marimo/0.25.2/assets/index-abcdef12.js', {
			headers: { 'Accept-Encoding': encoding },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Encoding')).toBe(encoding);
		expect(response.headers.get('Content-Type')).toMatch(/javascript/);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
		expect(response.headers.get('Vary')).toBe('Accept-Encoding');
		const decode = encoding === 'br' ? brotliDecompressSync : gunzipSync;
		expect(decode(Buffer.from(await response.arrayBuffer())).toString()).toBe(code);
	},
);

it('serves HEAD and identity variants, and revalidates unhashed resources', async () => {
	const { app, stage, code } = fixture();
	stage();
	const plain = await app.request('/_marimo/0.25.2/assets/index-abcdef12.js');
	expect(await plain.text()).toBe(code);
	const head = await app.request('/_marimo/0.25.2/assets/index-abcdef12.js', {
		method: 'HEAD',
		headers: { 'Accept-Encoding': 'gzip' },
	});
	expect(head.headers.get('Content-Encoding')).toBe('gzip');
	expect(await head.text()).toBe('');
	const response = await app.request('/_marimo/0.25.2/config.json');
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
});

it.each(['/_marimo/0.25.2/index.html', '/_marimo/0.25.2/INDEX.HTM'])(
	'never serves staged HTML on the hub origin: %s',
	async (path) => {
		const { app, stage } = fixture();
		stage();
		for (const method of ['GET', 'HEAD']) {
			const response = await app.request(path, { method, headers: { 'Accept-Encoding': 'br' } });
			expect(response.status).toBe(404);
			expect(response.headers.get('Content-Type')).not.toMatch(/html/);
			expect(response.headers.get('Cache-Control')).toBe('no-store');
		}
	},
);

it.each([
	'/_marimo/0.25.2/assets/missing.js',
	'/_marimo/latest/assets/index-abcdef12.js',
	'/_marimo/0.25.2/%2fetc%2fpasswd',
	'/_marimo/0.25.2/assets/%2e%2e%2fconfig.json',
	'/_marimo/9.9.9/index.html',
	'/_marimo/0.25.2-/assets/index-abcdef12.js',
	'/_marimo/0.25.2../assets/index-abcdef12.js',
])('never serves the SPA for missing or invalid asset paths: %s', async (path) => {
	const { app, stage } = fixture();
	stage();
	const response = await app.request(path);
	expect(response.status).toBe(404);
	expect(await response.text()).not.toContain('SPA fallback');
	expect(response.headers.get('Cache-Control')).toBe('no-store');
});

it('rejects writes and refuses to overwrite a published version', async () => {
	const { app, stage, target, code } = fixture();
	stage();
	const rejected = await app.request('/_marimo/0.25.2/index.html', { method: 'POST' });
	expect(rejected.status).toBe(405);
	expect(rejected.headers.get('Cache-Control')).toBe('no-store');
	expect(stage).toThrow('Refusing to replace immutable assets');
	expect(readFileSync(join(target, '_marimo/0.25.2/assets/index-abcdef12.js'), 'utf8')).toBe(code);
});

it('cleans failed staging and rejects symlinks and version traversal', () => {
	const { source, target, stage } = fixture();
	symlinkSync(join(source, 'index.html'), join(source, 'leak.html'));
	expect(stage).toThrow('symlinks');
	expect(readdirSync(join(target, '_marimo'))).toEqual([]);
	for (const version of ['../0.25.2', '0.25.2-', '0.25.2..'])
		expect(() => stageMarimoAssets({ sourceRoot: source, version, staticRoot: target })).toThrow(
			'exact marimo release',
		);
});

it('rejects a missing index and a destination inside the source tree', () => {
	const { source, target, stage } = fixture();
	expect(() =>
		stageMarimoAssets({ sourceRoot: source, version: '0.25.2', staticRoot: source }),
	).toThrow('outside the source');
	rmSync(join(source, 'index.html'));
	expect(stage).toThrow('no index.html');
	expect(readdirSync(join(target, '_marimo'))).toEqual([]);
});

it('rejects staging through a symlink into the source before creating a temporary tree', () => {
	const { source, target } = fixture();
	symlinkSync(source, target, 'dir');
	expect(() =>
		stageMarimoAssets({ sourceRoot: source, version: '0.25.2', staticRoot: target }),
	).toThrow('outside the source');
	expect(readdirSync(join(source, '_marimo'))).toEqual([]);
	expect(readFileSync(join(source, 'index.html'), 'utf8')).toContain('index-abcdef12.js');
});

it('keeps an existing published version intact when a different version fails staging', async () => {
	const { source, target, stage, app, code } = fixture();
	stage();
	rmSync(join(source, 'index.html'));
	expect(() =>
		stageMarimoAssets({ sourceRoot: source, version: '0.25.3', staticRoot: target }),
	).toThrow('no index.html');
	expect(readdirSync(join(target, '_marimo'))).toEqual(['0.25.2']);
	const response = await app.request('/_marimo/0.25.2/assets/index-abcdef12.js');
	expect(await response.text()).toBe(code);
});

it('respects rejected encodings and serves byte ranges without the SPA fallback', async () => {
	const { app, stage, code } = fixture();
	stage();
	const response = await app.request('/_marimo/0.25.2/assets/index-abcdef12.js', {
		headers: { 'Accept-Encoding': 'br;q=0, gzip;q=0', Range: 'bytes=0-9' },
	});
	expect(response.status).toBe(206);
	expect(response.headers.get('Content-Encoding')).toBeNull();
	expect(response.headers.get('Content-Range')).toBe(`bytes 0-9/${code.length}`);
	expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	expect(response.headers.get('Cache-Control')).toContain('immutable');
	expect(await response.text()).toBe(code.slice(0, 10));
	const invalid = await app.request('/_marimo/0.25.2/assets/index-abcdef12.js', {
		headers: { Range: `bytes=${code.length}-` },
	});
	expect(invalid.status).toBe(416);
	expect(invalid.headers.get('Cache-Control')).toBe('no-store');
	expect(await invalid.text()).not.toContain('SPA fallback');
});

it('stages the same release versions that the asset route serves', () => {
	expect(MARIMO_RELEASE_VERSION.source).toBe(`^${MARIMO_VERSION_PATTERN}$`);
});
