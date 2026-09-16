import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { ARTIFACT_ID, WHEEL_BASE64 } from './runtime.generated';

function marimoImports(source: string): string[] {
	return JSON.parse(
		execFileSync(
			'python3',
			[
				'-c',
				`import ast, json, sys
modules = []
for node in ast.walk(ast.parse(sys.stdin.read())):
    if isinstance(node, ast.Import):
        modules.extend(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
        modules.append(node.module)
print(json.dumps([name for name in modules if name.split('.')[0] == 'marimo']))`,
			],
			{ input: source, encoding: 'utf8' },
		),
	) as string[];
}

describe('runtime artifact', () => {
	it.each([
		'import marimo',
		'import os, marimo as mo',
		'import marimo._server as server',
		'from marimo import App',
		'from marimo._server import (\n    app,\n)',
	])('detects Python dependencies: %s', (source) => {
		expect(marimoImports(source)).toHaveLength(1);
	});
	it('does not mistake comments, strings or bridge imports for marimo dependencies', () => {
		expect(
			marimoImports(
				'# import marimo\nvalue = "from marimo import App"\nimport marimohub_notebook_bridge',
			),
		).toEqual([]);
	});
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
		expect(strFromU8(files[entrypoints])).toBe(
			'[marimo.server.asgi.lifespan]\nmarimohub_notebook_bridge = marimohub_notebook_bridge:lifespan\n',
		);
		for (const [path, content] of Object.entries(files)) {
			if (path.endsWith('.py')) {
				expect(marimoImports(strFromU8(content)), path).toEqual([]);
			}
		}
	});
});
