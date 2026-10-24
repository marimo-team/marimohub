import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertBuiltAssets } from './buildAssets';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function output(files: Record<string, string>): string {
	const directory = mkdtempSync(join(tmpdir(), 'marimohub-doc-assets-'));
	directories.push(directory);
	for (const [path, content] of Object.entries(files)) {
		const file = join(directory, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	return directory;
}

it('rejects missing page hydration chunks even when HTML renders', () => {
	const directory = output({
		'guide/index.html': '<link rel="modulepreload" href="/assets/guide.hash.lean.js">',
		'assets/guide.hash.js': 'export default {};',
	});
	expect(() => assertBuiltAssets(directory, '/')).toThrow(
		'guide/index.html: /assets/guide.hash.lean.js',
	);
});

it('resolves local assets with a base path and ignores external assets', () => {
	const directory = output({
		'guide/index.html': [
			'<link rel="modulepreload" href="/docs/assets/guide.hash.lean.js">',
			'<script src="../assets/app.js?version=1"></script>',
			'<link rel="stylesheet" href="/docs/assets/style.css">',
			'<script src="https://cdn.example.com/widget.js"></script>',
		].join('\n'),
		'assets/guide.hash.lean.js': 'export default {};',
		'assets/app.js': '',
		'assets/style.css': '',
	});
	expect(() => assertBuiltAssets(directory, '/docs/')).not.toThrow();
});

it('rejects missing stylesheets and scripts together', () => {
	const directory = output({
		'index.html': '<script src="/app.js"></script><link rel="stylesheet" href="/style.css">',
	});
	expect(() => assertBuiltAssets(directory, '/')).toThrow(
		'index.html: /app.js\nindex.html: /style.css',
	);
});
