/**
 * Maps a site route path to the raw-markdown twin emitted by vitepress-plugin-llms.
 *
 * The plugin flattens directory indexes: `/deploying/` is served from
 * `deploying.md`, not `deploying/index.md` — only the root keeps `index.md`.
 */
export function mdUrlForPath(path: string): string {
	const clean = path.replace(/[?#].*$/, '');
	if (clean === '/' || clean === '/index.html') return '/index.md';
	return `${clean.replace(/\.html$/, '').replace(/\/$/, '')}.md`;
}
