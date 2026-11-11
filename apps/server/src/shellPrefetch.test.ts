import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { injectShellPrefetch, SHELL_PREFETCH_SCRIPT } from './shellPrefetch';

function run(path: string, base = '/', respond: 'resolve' | 'stall' | 'reject' = 'resolve') {
	const fetch = vi.fn((_url: URL, _init: RequestInit) =>
		respond === 'resolve'
			? Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }))
			: respond === 'reject'
				? Promise.reject(new TypeError('Network unavailable'))
				: new Promise<Response>(() => {}),
	);
	const window: Record<string, unknown> = {};
	const pending = new Map<number, () => void>();
	let nextTimer = 0;
	runInNewContext(SHELL_PREFETCH_SCRIPT, {
		document: { baseURI: `https://hub.example${base}` },
		location: new URL(path, 'https://hub.example'),
		window,
		fetch,
		URL,
		URLSearchParams,
		AbortController,
		setTimeout: (fn: () => void) => {
			pending.set(++nextTimer, fn);
			return nextTimer;
		},
		clearTimeout: (id: number) => pending.delete(id),
	});
	const flushTimers = () => {
		for (const [id, fn] of [...pending]) {
			pending.delete(id);
			fn();
		}
	};
	return {
		urls: fetch.mock.calls.map(([url]) => String(url)),
		signals: fetch.mock.calls.map(([, init]) => init.signal!),
		window,
		flushTimers,
		timerCount: () => pending.size,
	};
}

it('starts path-derived requests before entry scripts with normalized filters and base path', () => {
	const { urls, window, flushTimers } = run(
		'/hub/projects/proj-123?q=%20revenue%20&status=garbage&tag=',
		'/hub/',
	);
	expect(urls).toContain(
		'https://hub.example/hub/api/v1/projects/proj-123/notebooks?limit=100&q=revenue',
	);
	expect(urls).toContain('https://hub.example/hub/api/v1/projects/proj-123/sessions');
	expect(window.__MARIMOHUB_PREFETCH__).toBeDefined();
	flushTimers();
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

it('aborts a prefetch only while its headers are pending', async () => {
	const answered = run('/');
	const cache = answered.window.__MARIMOHUB_PREFETCH__ as {
		responses: Record<string, Promise<Response | null>>;
	};
	await Promise.all(Object.values(cache.responses));
	answered.flushTimers();
	expect(answered.signals.some((signal) => signal.aborted)).toBe(false);

	const stalled = run('/', '/', 'stall');
	stalled.flushTimers();
	expect(stalled.signals.length).toBeGreaterThan(0);
	expect(stalled.signals.every((signal) => signal.aborted)).toBe(true);
});

it('drops fetch preloads that the script replaces and keeps other links', () => {
	const html = injectShellPrefetch(
		[
			'<head><base href="/" />',
			'<link rel="preload" href="./api/v1/theme" as="fetch" crossorigin="use-credentials" />',
			'<link rel="preload" href="./api/v1/me" as="fetch" crossorigin="anonymous" />',
			"<link as='fetch' rel='preload' href='./api/v1/capabilities'>",
			'<link rel="modulepreload" href="./assets/chunk.js" />',
			'<link rel="preload" href="./font.woff2" as="font" />',
			'</head>',
		].join('\n'),
	);
	expect(html).not.toMatch(/href=["']\.\/api\/v1/);
	expect(html).toContain('rel="modulepreload"');
	expect(html).toContain('as="font"');
	expect(html).toContain(SHELL_PREFETCH_SCRIPT);
});

it('clears abort timers when prefetches settle, including rejections', async () => {
	for (const mode of ['resolve', 'reject'] as const) {
		const { window, timerCount } = run('/', '/', mode);
		const cache = window.__MARIMOHUB_PREFETCH__ as {
			responses: Record<string, Promise<Response | null>>;
		};
		const responses = await Promise.all(Object.values(cache.responses));
		if (mode === 'reject') expect(responses.every((response) => response === null)).toBe(true);
		expect(timerCount()).toBe(1);
	}
});

it('keeps fetch preloads when a shell has no base tag to anchor the script', () => {
	const shell =
		'<head><link rel="preload" href="./api/v1/me" as="fetch" crossorigin="use-credentials" /></head>';
	expect(injectShellPrefetch(shell)).toBe(shell);
});
