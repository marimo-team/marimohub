import { spawn } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the real launcher under plain `node`, with `node:sea` replaced by a
// preload that serves a stand-in payload. The unpacked entrypoint reports what
// the launcher handed it, so a run's stdout tells us which payload was loaded.
const launcher = fileURLToPath(new URL('./launcher.cjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const BUILD_ID = 'testbuild';
const ENTRY = 'dist/index.mjs';
const SHIM = 'importShim.cjs';
const SHIM_SOURCE = readFileSync(
	fileURLToPath(new URL('./importShim.cjs', import.meta.url)),
	'utf8',
);
const ENTRY_SOURCE = `console.log(JSON.stringify({
	loaded: import.meta.url,
	staticRoot: process.env.MARIMOHUB_STATIC_ROOT,
	version: process.env.MARIMOHUB_VERSION,
}));`;
const STUB_SOURCE = `const Module = require('node:module');
const manifest = ${JSON.stringify({ buildId: BUILD_ID, version: '0.0.0-test', files: [ENTRY, 'public/index.html', SHIM] })};
const assets = {
	[${JSON.stringify(ENTRY)}]: ${JSON.stringify(ENTRY_SOURCE)},
	'public/index.html': '<div id="root"></div>',
	[${JSON.stringify(SHIM)}]: ${JSON.stringify(SHIM_SOURCE)},
};
// Lets one test drive the launcher into a failing extract.
if (process.env.SEA_STUB_MISSING_ASSET) manifest.files = [...manifest.files, 'absent'];
const load = Module._load;
Module._load = function (request, ...rest) {
	if (request !== 'node:sea') return load.call(this, request, ...rest);
	return {
		getAsset: () => JSON.stringify(manifest),
		getRawAsset: (name) => Buffer.from(assets[name]),
	};
};`;

// Scratch trees live under node_modules/.cache rather than the OS tmpdir: the
// launcher rejects anything below a world-writable directory such as /tmp.
let scratch: string;
let stub: string;

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

const runLauncher = (cacheDir: string, env: Record<string, string> = {}): Promise<Run> =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['-r', stub, launcher], {
			env: { ...process.env, MARIMOHUB_SEA_CACHE_DIR: cacheDir, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			resolve({ code, stdout, stderr });
		});
	});

const loadedPayload = (run: Run) => {
	expect(run.stderr).toBe('');
	expect(run.code).toBe(0);
	return JSON.parse(run.stdout) as { loaded: string; staticRoot: string; version: string };
};

const freshCache = (name: string) => join(mkdtempSync(join(scratch, `${name}-`)), 'cache');

beforeAll(() => {
	mkdirSync(join(repoRoot, 'node_modules/.cache'), { recursive: true });
	scratch = mkdtempSync(join(repoRoot, 'node_modules/.cache/sea-launcher-'));
	stub = join(scratch, 'sea-stub.cjs');
	writeFileSync(stub, STUB_SOURCE);
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('SEA launcher', () => {
	it('unpacks the payload on first start and reuses it afterwards', async () => {
		const cache = freshCache('reuse');
		const payloadDir = join(cache, BUILD_ID);

		const first = loadedPayload(await runLauncher(cache));
		expect(first.loaded).toBe(`file://${join(payloadDir, ENTRY)}`);
		expect(first.staticRoot).toBe(join(payloadDir, 'public'));
		expect(first.version).toBe('0.0.0-test');
		expect(existsSync(join(payloadDir, '.ready'))).toBe(true);
		expect(existsSync(join(payloadDir, 'public/index.html'))).toBe(true);
		expect(readdirSync(cache)).toEqual([BUILD_ID]);

		writeFileSync(join(payloadDir, 'marker'), '');
		const second = loadedPayload(await runLauncher(cache));
		expect(second.loaded).toBe(first.loaded);
		expect(existsSync(join(payloadDir, 'marker'))).toBe(true);
	});

	it('leaves a single payload when two instances start at once', async () => {
		const cache = freshCache('concurrent');
		const runs = await Promise.all([runLauncher(cache), runLauncher(cache)]);
		for (const run of runs) loadedPayload(run);
		expect(readdirSync(cache)).toEqual([BUILD_ID]);
		expect(existsSync(join(cache, BUILD_ID, '.ready'))).toBe(true);
	});

	it('repairs a payload directory that lost its ready marker under concurrent starts', async () => {
		const rounds = Number(process.env.SEA_LAUNCHER_STRESS_ROUNDS ?? 3);
		for (let round = 0; round < rounds; round++) {
			const cache = freshCache('stale-concurrent');
			const payloadDir = join(cache, BUILD_ID);
			mkdirSync(payloadDir, { recursive: true, mode: 0o700 });
			writeFileSync(join(payloadDir, 'leftover'), '');

			const runs = await Promise.all(Array.from({ length: 12 }, () => runLauncher(cache)));
			for (const run of runs) loadedPayload(run);
			expect(readdirSync(cache)).toEqual([BUILD_ID]);
			expect(existsSync(join(payloadDir, '.ready'))).toBe(true);
			expect(existsSync(join(payloadDir, 'leftover'))).toBe(false);
			expect(existsSync(join(payloadDir, ENTRY))).toBe(true);
		}
	}, 60_000);

	it('replaces a payload directory that lost its ready marker', async () => {
		const cache = freshCache('stale');
		const payloadDir = join(cache, BUILD_ID);
		mkdirSync(payloadDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(payloadDir, 'leftover'), '');

		loadedPayload(await runLauncher(cache));
		expect(existsSync(join(payloadDir, '.ready'))).toBe(true);
		expect(existsSync(join(payloadDir, 'leftover'))).toBe(false);
		expect(existsSync(join(payloadDir, ENTRY))).toBe(true);
	});

	// A supervisor restarting a binary that cannot finish extracting would
	// otherwise leave most of a payload behind under `unpack-*` every time.
	it('leaves nothing behind when extraction fails', async () => {
		const cache = freshCache('failed-extract');

		for (let attempt = 0; attempt < 3; attempt++) {
			const run = await runLauncher(cache, { SEA_STUB_MISSING_ASSET: '1' });
			expect(run.code).not.toBe(0);
			expect(readdirSync(cache)).toEqual([]);
		}
	});

	it('refuses a cache root that is a symlink', async () => {
		const base = mkdtempSync(join(scratch, 'symlink-'));
		mkdirSync(join(base, 'real'), { mode: 0o700 });
		symlinkSync(join(base, 'real'), join(base, 'cache'));

		const run = await runLauncher(join(base, 'cache'));
		expect(run.code).toBe(1);
		expect(run.stderr).toContain('is a symlink');
		expect(readdirSync(join(base, 'real'))).toEqual([]);
	});

	it.each([
		['world-writable', 0o777],
		['sticky world-writable', 0o1777],
		['group-writable', 0o770],
	])('refuses a cache below a %s ancestor', async (_label, mode) => {
		const base = mkdtempSync(join(scratch, 'ancestor-'));
		const ancestor = join(base, 'shared');
		mkdirSync(ancestor);
		chmodSync(ancestor, mode);

		const run = await runLauncher(join(ancestor, 'cache'));
		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`${ancestor} is group or world-writable`);
		expect(existsSync(join(ancestor, 'cache', BUILD_ID))).toBe(false);
	});
});
