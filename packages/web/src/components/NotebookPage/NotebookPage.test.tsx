import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotebookPage } from './NotebookPage';
import type { Session } from '@/types';

const PID = 'proj-x';
const NID = 'nb-1';

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

function runningSession(overrides: Partial<Session> = {}): Session {
	return {
		session_id: 'sess-1',
		notebook_id: NID,
		project_id: PID,
		user_id: 'me',
		status: 'running',
		started_at: '2025-03-05T14:00:00Z',
		last_heartbeat: '2025-03-05T14:00:00Z',
		sandbox_url: 'https://sandbox.example/kernel',
		...overrides,
	} as Session;
}

interface FetchOptions {
	role: 'admin' | 'editor' | 'viewer';
	viewerMode?: 'static' | 'ephemeral-sandbox';
	/** Body of GET .../html; null = 404 (no snapshot captured yet). */
	html?: string | null;
	session?: Session;
}

/** Route every request the page makes to a canned response; return the fetch spy. */
function makeFetch(opts: FetchOptions) {
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';

		if (method === 'POST' && url.endsWith(`/notebooks/${NID}/sessions`)) {
			return ok({ ...(opts.session ?? runningSession()), reused: false });
		}
		if (url.endsWith(`/notebooks/${NID}/html`)) {
			if (opts.html == null) {
				return new Response(
					JSON.stringify({ success: false, error: { code: 'NO_HTML_SNAPSHOT', message: 'none' } }),
					{ status: 404, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(opts.html, {
				headers: {
					'content-type': 'text/html',
					'X-Marimohub-Captured-At': '2025-03-05T14:00:00Z',
				},
			});
		}
		if (url.endsWith(`/notebooks/${NID}`)) {
			return ok({ meta: { id: NID, title: 'Forecast', author: 'me' } });
		}
		if (url.includes('/capabilities')) {
			return ok({
				federation: { available: false },
				viewer_mode: opts.viewerMode ?? 'static',
				limits: {},
			});
		}
		if (url.includes('/users')) return ok({});
		if (url.endsWith(`/projects/${PID}`)) {
			return ok({ id: PID, name: 'P', description: '', your_role: opts.role });
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return impl;
}

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[`/projects/${PID}/notebooks/${NID}`]}>
			<QueryClientProvider client={client}>
				<Suspense fallback={<div>loading</div>}>{children}</Suspense>
			</QueryClientProvider>
		</MemoryRouter>
	);
	return render(
		<Routes>
			<Route path="/projects/:pid/notebooks/:nid" element={<NotebookPage />} />
		</Routes>,
		{ wrapper },
	);
}

const sessionPosts = (impl: ReturnType<typeof makeFetch>) =>
	impl.mock.calls.filter(
		([url, init]) => String(url).endsWith('/sessions') && init?.method === 'POST',
	);

beforeEach(() => {
	// jsdom has no matchMedia; Tooltip's mobile check needs it.
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('NotebookPage viewer modes', () => {
	it('editor: starts a session and embeds the kernel iframe, no banner', async () => {
		const impl = makeFetch({ role: 'editor' });
		const { container } = renderPage();

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel"]'),
			).not.toBeNull(),
		);
		expect(sessionPosts(impl)).toHaveLength(1);
		expect(screen.queryByText(/won't be saved/)).toBeNull();
	});

	it('viewer + static: renders the snapshot sandboxed, never starts a session', async () => {
		const impl = makeFetch({ role: 'viewer', html: '<html><body>outputs</body></html>' });
		const { container } = renderPage();

		await waitFor(() => expect(screen.getByText(/Static snapshot of outputs/)).toBeInTheDocument());
		const iframe = container.querySelector('iframe');
		expect(iframe).not.toBeNull();
		expect(iframe!.getAttribute('srcdoc')).toContain('outputs');
		// Opaque origin: no allow-same-origin, unlike the live-kernel iframe.
		expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
		expect(sessionPosts(impl)).toHaveLength(0);
	});

	it('viewer + static without a snapshot: empty state, never starts a session', async () => {
		const impl = makeFetch({ role: 'viewer', html: null });
		renderPage();

		await waitFor(() => expect(screen.getByText('No outputs yet')).toBeInTheDocument());
		expect(sessionPosts(impl)).toHaveLength(0);
	});

	it('viewer + ephemeral-sandbox: starts a session and shows the not-saved banner', async () => {
		const impl = makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			session: runningSession({ ephemeral: true }),
		});
		const { container } = renderPage();

		await waitFor(() => expect(screen.getByText(/won't be saved/)).toBeInTheDocument());
		expect(container.querySelector('iframe[src="https://sandbox.example/kernel"]')).not.toBeNull();
		expect(sessionPosts(impl)).toHaveLength(1);
	});
});
