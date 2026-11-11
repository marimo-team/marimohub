import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { precompressFile } from './precompress.mjs';

// Mirrors MARIMO_VERSION_PATTERN in packages/core/src/url.ts; marimoAssets.test.ts checks parity.
export const MARIMO_RELEASE_VERSION =
	/^\d+\.\d+\.\d+(?:[a-zA-Z][a-zA-Z0-9]*)?(?:[.-][a-zA-Z0-9]+)*$/;
const COMPRESSIBLE_EXTENSIONS = ['html', 'js', 'mjs', 'css', 'json', 'svg', 'wasm', 'txt'];

function assertOutsideSource(root, source) {
	if (root === source || root.startsWith(`${source}${sep}`))
		throw new Error('The staging directory must be outside the source assets');
}

export function stageMarimoAssets({ sourceRoot, version, staticRoot }) {
	if (!MARIMO_RELEASE_VERSION.test(version))
		throw new Error('Expected an exact marimo release version');
	if (!lstatSync(sourceRoot).isDirectory()) throw new Error('Marimo assets must be a directory');
	const root = join(staticRoot, '_marimo');
	const destination = join(root, version);
	assertOutsideSource(resolve(root), resolve(sourceRoot));
	if (existsSync(destination))
		throw new Error(`Refusing to replace immutable assets: ${destination}`);
	mkdirSync(root, { recursive: true });
	assertOutsideSource(realpathSync(root), realpathSync(sourceRoot));
	const temporary = mkdtempSync(join(root, '.staging-'));
	try {
		const files = [];
		function copy(relative) {
			for (const entry of readdirSync(join(sourceRoot, relative), { withFileTypes: true })) {
				const name = join(relative, entry.name);
				const target = join(temporary, name);
				if (entry.isSymbolicLink()) throw new Error(`Asset symlinks are not supported: ${name}`);
				if (entry.isDirectory()) {
					mkdirSync(target);
					copy(name);
				} else if (entry.isFile()) {
					copyFileSync(join(sourceRoot, name), target);
					files.push(target);
				} else throw new Error(`Asset is not a regular file: ${name}`);
			}
		}
		copy('');
		if (
			!existsSync(join(temporary, 'index.html')) ||
			!lstatSync(join(temporary, 'index.html')).isFile()
		)
			throw new Error('Marimo assets have no index.html');
		for (const path of files) precompressFile(path, { extensions: COMPRESSIBLE_EXTENSIONS });
		// Publish only complete versions; an interrupted build leaves no partially usable origin.
		renameSync(temporary, destination);
		return destination;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const python = args[0];
	const staticRoot = args[1];
	if (!python || !staticRoot || args.length !== 2) {
		throw new Error(
			'Usage: node scripts/stage-marimo-assets.mjs /path/to/python /path/to/static-root',
		);
	}
	const metadata = JSON.parse(
		execFileSync(
			python,
			[
				'-c',
				'import json; from importlib.metadata import distribution; d = distribution("marimo"); print(json.dumps({"version": d.version, "sourceRoot": str(d.locate_file("marimo/_static"))}))',
			],
			{ encoding: 'utf8' },
		),
	);
	console.log(stageMarimoAssets({ ...metadata, staticRoot: resolve(staticRoot) }));
}
