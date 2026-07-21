// Vercel Edge Middleware: serves the raw-markdown twin of a page when the
// client asks for it via `Accept: text/markdown`. The twins (and llms.txt)
// are emitted at build time by vitepress-plugin-llms.

export const config = {
	matcher:
		'/((?!assets/|vp-icons\\.css|hashmap\\.json|llms\\.txt|llms-full\\.txt|sitemap\\.xml|favicon|404\\.html).*)',
};

export default async function middleware(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	const { pathname } = url;

	// .md paths are real static files; letting them through also guarantees the
	// same-origin fetch below can never loop back into this branch.
	if (pathname.endsWith('.md')) return;

	const accept = request.headers.get('accept') ?? '';
	if (!accept.includes('text/markdown')) return;

	// Mirrors mdUrlForPath in .vitepress/theme/mdUrl.ts: the plugin flattens
	// directory indexes (`/deploying/` -> `deploying.md`); only root keeps index.md.
	const mdPathname = pathname === '/' ? '/index.md' : `${pathname.replace(/\/$/, '')}.md`;

	// Forward the bypass header so the twin fetch also clears deployment
	// protection on preview deployments.
	const headers = new Headers();
	const bypass = request.headers.get('x-vercel-protection-bypass');
	if (bypass) headers.set('x-vercel-protection-bypass', bypass);

	const response = await fetch(new URL(mdPathname, url.origin), { headers });
	// The content-type guard keeps us from re-serving an HTML interstitial
	// (e.g. the SSO page on protected previews) as markdown.
	if (!response.ok || !(response.headers.get('content-type') ?? '').includes('markdown')) return;

	return new Response(response.body, {
		status: 200,
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': response.headers.get('cache-control') ?? 'public, max-age=3600',
			'access-control-allow-origin': '*',
			vary: 'Accept',
		},
	});
}
