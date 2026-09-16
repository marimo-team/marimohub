import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { ARTIFACT_ID, WHEEL_BASE64 } from './runtime.generated';

describe('runtime artifact', () => {
	it('keeps runtime discovery, installation and fallback isolated', () => {
		expect(() =>
			execFileSync('python3', ['python/test_runtime.py'], {
				stdio: 'pipe',
				cwd: new URL('../', import.meta.url),
			}),
		).not.toThrow();
	});
	it('matches the browser and Python sources', () => {
		expect(() =>
			execFileSync(process.execPath, ['scripts/generate.mjs', '--check'], {
				env: { ...process.env, TZ: 'UTC' },
				stdio: 'pipe',
				cwd: new URL('../', import.meta.url),
			}),
		).not.toThrow();
	}, 30_000);
	it('contains an offline wheel with a lifespan entrypoint and no dependency on marimo internals', () => {
		const files = unzipSync(Buffer.from(WHEEL_BASE64, 'base64'));
		expect(strFromU8(files['marimohub_notebook_bridge/identity'])).toBe(ARTIFACT_ID);
		const entrypoints = Object.keys(files).find((path) => path.endsWith('/entry_points.txt'))!;
		expect(strFromU8(files[entrypoints])).toContain('marimo.server.asgi.lifespan');
		expect(strFromU8(files['marimohub_notebook_bridge/__init__.py'])).not.toContain('from marimo');
	});
});
