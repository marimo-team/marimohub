import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { injectShellPrefetch, SHELL_PREFETCH_SCRIPT } from './shellPrefetch';

function run(path: string, base = '/') {
	const fetch = vi.fn(
		async (_url: URL) => new Response('{}', { headers: { 'content-type': 'application/json' } }),
	);
	const window: Record<string, unknown> = {};
	const timers: (() => void)[] = [];
	runInNewContext(SHELL_PREFETCH_SCRIPT, {
		document: { baseURI: `https://hub.example${base}` },
		location: new URL(path, 'https://hub.example'),
		window,
		fetch,
		URL,
		URLSearchParams,
		AbortSignal: { timeout: vi.fn(() => new AbortController().signal) },
		setTimeout: (fn: () => void) => timers.push(fn),
	});
	return { urls: fetch.mock.calls.map(([url]) => String(url)), window, timers };
}

it('starts path-derived requests before entry scripts with normalized filters and base path', () => {
	const { urls, window, timers } = run(
		'/hub/projects/proj-123?q=%20revenue%20&status=garbage&tag=',
		'/hub/',
	);
	expect(urls).toContain(
		'https://hub.example/hub/api/v1/projects/proj-123/notebooks?limit=100&q=revenue',
	);
	expect(urls).toContain('https://hub.example/hub/api/v1/projects/proj-123/sessions');
	expect(window.__MARIMOHUB_PREFETCH__).toBeDefined();
	timers.forEach((fn) => fn());
	expect(window.__MARIMOHUB_PREFETCH__).toBeUndefined();
	const html = injectShellPrefetch(
		'<head><base href="/hub/"><script type="module" src="entry.js"></script></head>',
	);
	expect(html.indexOf(SHELL_PREFETCH_SCRIPT)).toBeLessThan(html.indexOf('type="module"'));
});

it('does not prefetch a notebook app for nested jobs or malformed ids', () => {
	for (const path of [
		'/projects/proj-123/notebooks/nb-123/jobs',
		'/projects/%3Cscript%3E/notebooks/nb-123',
	])
		expect(run(path).urls.some((url) => url.endsWith('/app'))).toBe(false);
	expect(run('/projects/proj-123/notebooks/nb-123').urls).toContain(
		'https://hub.example/api/v1/projects/proj-123/notebooks/nb-123/app',
	);
});
