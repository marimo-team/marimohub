import { join } from 'node:path';
import type { Plugin } from 'vite';
import { precompressFile } from '../../scripts/precompress.mjs';

// The HTML shell is rewritten for the deployment's base URL at request time.
const EXTENSIONS = ['js', 'css', 'json', 'svg', 'wasm', 'txt'];

export function precompress(): Plugin {
	return {
		name: 'precompress-assets',
		apply: 'build',
		writeBundle({ dir }, bundle) {
			if (!dir) throw new Error('Asset compression requires an output directory');
			// Vite rewrites preload dependencies after generateBundle hooks.
			for (const file of Object.values(bundle))
				precompressFile(join(dir, file.fileName), { extensions: EXTENSIONS });
		},
	};
}
