import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

export function precompress(): Plugin {
	return {
		name: 'precompress-assets',
		apply: 'build',
		async writeBundle({ dir }, bundle) {
			if (!dir) throw new Error('Asset compression requires an output directory');
			for (const file of Object.values(bundle)) {
				// The HTML shell is rewritten for the deployment's base URL at request time.
				if (!/\.(?:js|css|json|svg|wasm|txt)$/.test(file.fileName)) continue;
				// Vite rewrites preload dependencies after generateBundle hooks.
				const path = join(dir, file.fileName);
				const bytes = await readFile(path);
				if (bytes.byteLength < 1024) continue;
				for (const [extension, source] of [
					['br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })],
					['gz', gzipSync(bytes, { level: 9 })],
				] as const) {
					if (source.byteLength < bytes.byteLength) {
						await writeFile(`${path}.${extension}`, source);
					}
				}
			}
		},
	};
}
