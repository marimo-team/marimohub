import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export function assertBuiltAssets(outDir: string, base: string): void {
	const missing: string[] = [];
	for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
		const file = join(entry.parentPath, entry.name);
		const page = relative(outDir, file);
		const html = readFileSync(file, 'utf8');
		const origin = 'https://docs-build.invalid';
		const pageUrl = new URL(`${base}${page}`, origin);
		for (const [, reference] of html.matchAll(
			/(?:src|href)="([^"]+\.(?:js|css)(?:[?#][^"]*)?)"/g,
		)) {
			const asset = new URL(reference, pageUrl);
			if (asset.origin !== origin) continue;
			if (
				!asset.pathname.startsWith(base) ||
				!existsSync(join(outDir, asset.pathname.slice(base.length)))
			) {
				missing.push(`${page}: ${reference}`);
			}
		}
	}
	if (missing.length > 0)
		throw new Error(`Docs build references missing assets:\n${missing.join('\n')}`);
}
