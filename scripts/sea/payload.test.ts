import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectPayload, SHIM_ASSET } from './payload.mjs';

// A build id that fails to move when an input moves is the dangerous failure:
// the launcher reuses any payload directory that already carries its `.ready`
// marker, so an upgraded binary would keep running the previous payload.
let scratch: string;
let inputs: Parameters<typeof collectPayload>[0];

const write = (path: string, contents: string) => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, contents);
};

const buildId = () => collectPayload(inputs).buildId;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), 'sea-payload-'));
	inputs = {
		serverDist: join(scratch, 'server'),
		webDist: join(scratch, 'web'),
		shim: join(scratch, 'importShim.cjs'),
		launcher: join(scratch, 'launcher.cjs'),
	};
	write(join(inputs.serverDist, 'index.mjs'), 'export const server = 1;');
	write(join(inputs.serverDist, 'workers/kernel.mjs'), 'export const worker = 1;');
	write(join(inputs.webDist, 'index.html'), '<div id="root"></div>');
	write(join(inputs.webDist, 'assets/app.js'), 'console.log(1);');
	write(inputs.shim, 'module.exports = (href) => import(href);');
	write(inputs.launcher, '// launcher');
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe('SEA payload', () => {
	it('is stable for unchanged inputs', () => {
		expect(buildId()).toBe(buildId());
		expect(buildId()).toMatch(/^[0-9a-f]{16}$/);
	});

	it('embeds the shim under the name the launcher requires', () => {
		const { assets } = collectPayload(inputs);
		expect(assets[SHIM_ASSET]).toBe(inputs.shim);
		expect(Object.keys(assets)).toEqual([
			'dist/index.mjs',
			'dist/workers/kernel.mjs',
			'public/assets/app.js',
			'public/index.html',
			SHIM_ASSET,
		]);
	});

	// launcher.cjs is CommonJS embedded in the executable and cannot import this
	// constant, so the two sides agree only by convention. A rename on one side
	// leaves the launcher requiring a file the build never embedded.
	it('uses the shim name the launcher requires', () => {
		const launcher = readFileSync(
			fileURLToPath(new URL('./launcher.cjs', import.meta.url)),
			'utf8',
		);
		expect(launcher).toContain(`'${SHIM_ASSET}'`);
	});

	it.each([
		['a server bundle file', () => write(join(inputs.serverDist, 'index.mjs'), 'changed')],
		[
			'an SPA file',
			() => write(join(inputs.webDist, 'index.html'), '<div id="root">changed</div>'),
		],
		['the import shim', () => write(inputs.shim, '// changed')],
		// The launcher is the SEA main, not an asset, so it is the input most
		// easily left out of the hash. It reads the unpacked payload, so a change
		// to it must not reuse a directory an older launcher wrote.
		['the launcher', () => write(inputs.launcher, '// changed')],
	])('changes when %s changes', (_label, mutate) => {
		const before = buildId();
		mutate();
		expect(buildId()).not.toBe(before);
	});

	it('changes when a file is added', () => {
		const before = buildId();
		write(join(inputs.webDist, 'assets/extra.js'), 'console.log(1);');
		expect(buildId()).not.toBe(before);
	});

	it('changes when a file is removed', () => {
		const before = buildId();
		rmSync(join(inputs.webDist, 'assets/app.js'));
		expect(buildId()).not.toBe(before);
	});

	// Hashing contents alone would collide here, and the launcher resolves the
	// SPA and the worker scripts by path.
	it('changes when a file is renamed but its contents are not', () => {
		const before = buildId();
		rmSync(join(inputs.serverDist, 'workers/kernel.mjs'));
		write(join(inputs.serverDist, 'workers/renamed.mjs'), 'export const worker = 1;');
		expect(buildId()).not.toBe(before);
	});

	// Raw concatenation makes the boundary between a key and its contents
	// invisible to the hash, so a single file can impersonate two.
	it('frames keys and contents so one file cannot stand in for two', () => {
		rmSync(inputs.serverDist, { recursive: true, force: true });
		write(join(inputs.serverDist, 'a'), 'A');
		write(join(inputs.serverDist, 'b'), 'B');
		const twoFiles = buildId();

		rmSync(inputs.serverDist, { recursive: true, force: true });
		write(join(inputs.serverDist, 'a'), 'Adist/bB');
		expect(buildId()).not.toBe(twoFiles);
	});

	// The launcher has no asset key of its own, so its bytes are hashed behind a
	// literal. Without one it would run straight on from the last keyed asset,
	// and these two payloads would produce the same byte stream.
	it('separates the launcher from the asset hashed immediately before it', () => {
		const shim = 'module.exports = (href) => import(href);';
		write(inputs.shim, shim);
		write(inputs.launcher, '// launcher');
		const before = buildId();

		write(inputs.shim, `${shim}// launcher`);
		write(inputs.launcher, '');
		expect(buildId()).not.toBe(before);
	});
});
