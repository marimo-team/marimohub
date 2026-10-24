import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function assertBuiltAssets(outDir: string, base: string): void {
	const missing: string[] = [];
	const baseUrl = new URL(base, 'https://docs-build.invalid/');
	const root = resolve(outDir);
	for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
		const file = join(entry.parentPath, entry.name);
		const page = relative(outDir, file);
		const html = readFileSync(file, 'utf8');
		const pageUrl = new URL(page.split(sep).map(encodeURIComponent).join('/'), baseUrl);
		for (const [, reference] of html.matchAll(
			/(?:src|href)="([^"]+\.(?:js|css)(?:[?#][^"]*)?)"/g,
		)) {
			const asset = new URL(reference, pageUrl);
			if (asset.origin !== baseUrl.origin) continue;
			let filePath: string | undefined;
			if (asset.pathname.startsWith(baseUrl.pathname)) {
				try {
					filePath = resolve(
						root,
						decodeURIComponent(asset.pathname.slice(baseUrl.pathname.length)),
					);
				} catch {
					// Malformed URL escapes cannot identify a local asset.
				}
			}
			if (!filePath?.startsWith(`${root}${sep}`) || !existsSync(filePath)) {
				missing.push(`${page}: ${reference}`);
			}
		}
	}
	if (missing.length > 0)
		throw new Error(`Docs build references missing assets:\n${missing.join('\n')}`);
}
