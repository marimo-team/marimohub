import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
		can: { attach: true, stop: true },
		...overrides,
	} as Session;
}

interface FetchOptions {
	role: 'admin' | 'editor' | 'viewer';
	viewerMode?: 'static' | 'applications' | 'ephemeral-sandbox';
	/** Body of GET .../html; null = 404 (no snapshot captured yet). */
	html?: string | null;
	session?: Session;
	/** Items served by GET /projects/{pid}/sessions (the app page's edit-activity poll). */
	projectSessions?: Session[];
	/** The notebook's current head version (staleness comparisons). */
	headVersion?: string;
	/** When set, POST .../sessions fails with this error code at this status. */
	createError?: { code: string; message: string; status: number };
}

/** Route every request the page makes to a canned response; return the fetch spy. */
function makeFetch(opts: FetchOptions) {
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';

		if (method === 'POST' && url.endsWith(`/notebooks/${NID}/sessions`)) {
			if (opts.createError) {
				const { code, message, status } = opts.createError;
				return new Response(JSON.stringify({ success: false, error: { code, message } }), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			}
			return ok({ ...(opts.session ?? runningSession()), reused: false });
		}
		if (url.endsWith(`/sessions/${(opts.session ?? runningSession()).session_id}`)) {
			return ok(opts.session ?? runningSession());
		}
		if (url.endsWith(`/projects/${PID}/sessions`)) {
			return ok({ items: opts.projectSessions ?? [], next_cursor: null });
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
			return ok({
				meta: { id: NID, title: 'Forecast', author: 'me' },
				source: { type: 'local', current_version_id: opts.headVersion ?? 'ver-head' },
			});
		}
		if (url.includes('/capabilities')) {
			const viewerMode = opts.viewerMode ?? 'static';
			return ok({
				federation: { available: false },
				viewer_mode: viewerMode,
				viewer_session_modes:
					viewerMode === 'ephemeral-sandbox'
						? ['app', 'edit']
						: viewerMode === 'applications'
							? ['app']
							: [],
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

function renderPage(variant: 'edit' | 'app' = 'edit') {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const path =
		variant === 'app'
			? `/projects/${PID}/notebooks/${NID}/app`
			: `/projects/${PID}/notebooks/${NID}`;
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[path]}>
			<QueryClientProvider client={client}>
				<Suspense fallback={<div>loading</div>}>{children}</Suspense>
			</QueryClientProvider>
		</MemoryRouter>
	);
	return render(
		<Routes>
			<Route path="/projects/:pid/notebooks/:nid" element={<NotebookPage />} />
			<Route path="/projects/:pid/notebooks/:nid/app" element={<NotebookPage variant="app" />} />
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

	it('viewer + applications: still the static view on the EDIT page (apps ≠ edit kernels)', async () => {
		const impl = makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			html: '<html><body>outputs</body></html>',
		});
		renderPage();

		await waitFor(() => expect(screen.getByText(/Static snapshot of outputs/)).toBeInTheDocument());
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

describe('NotebookPage app variant', () => {
	const appSession = (overrides: Partial<Session> = {}) =>
		runningSession({ mode: 'app', source_version_id: 'ver-head', ...overrides });

	it('starts a run session, shows app chrome, and hides edit-only affordances', async () => {
		const impl = makeFetch({ role: 'editor', session: appSession() });
		const { container } = renderPage('app');

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel"]'),
			).not.toBeNull(),
		);
		const [, init] = sessionPosts(impl)[0];
		expect(String(init?.body)).toContain('"mode":"app"');
		expect(screen.getByText('App')).toBeInTheDocument();
		expect(screen.getByText('Restart')).toBeInTheDocument();
		expect(screen.getByText('Stop')).toBeInTheDocument();
		expect(screen.queryByLabelText('Rename notebook')).toBeNull();
	});

	it('shows the staleness banner when the app trails the notebook head', async () => {
		makeFetch({
			role: 'editor',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
		expect(screen.getByText('Restart to update')).toBeInTheDocument();
	});

	it('suppresses the staleness banner while the notebook is being edited', async () => {
		makeFetch({
			role: 'editor',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
			projectSessions: [runningSession({ session_id: 'sess-edit', mode: 'edit' })],
		});
		const { container } = renderPage('app');

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		await waitFor(() => expect(screen.queryByText(/serving an older version/)).toBeNull());
	});

	it('shows no staleness banner when the app serves the head version', async () => {
		const { container } = (() => {
			makeFetch({ role: 'editor', session: appSession(), headVersion: 'ver-head' });
			return renderPage('app');
		})();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByText(/serving an older version/)).toBeNull();
	});

	it('viewer + applications: uses the app but gets no Stop/Restart controls', async () => {
		const impl = makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			session: appSession({ can: { attach: true, stop: false } }),
		});
		const { container } = renderPage('app');

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel"]'),
			).not.toBeNull(),
		);
		expect(sessionPosts(impl)).toHaveLength(1);
		expect(screen.getByText('App')).toBeInTheDocument();
		expect(screen.queryByText('Restart')).toBeNull();
		expect(screen.queryByText('Stop')).toBeNull();
	});

	it('viewer + applications: the staleness banner has no restart CTA', async () => {
		makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			session: appSession({ source_version_id: 'ver-old', can: { attach: true, stop: false } }),
			headVersion: 'ver-head',
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
		// Restarting the shared app is editor-only; a viewer clicking through
		// would 403 on the stop half.
		expect(screen.queryByText('Restart to update')).toBeNull();
	});

	it('Restart confirms before disconnecting everyone (with the connection hint)', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({
			role: 'editor',
			session: appSession({ active_connections: 3 }),
		});
		const { container } = renderPage('app');
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		await user.click(screen.getByText('Restart'));
		// The dialog, not a teardown, is what a click produces.
		expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/About 3 people are connected/)).toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
		await waitFor(() =>
			expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
		);
	});

	it('Stop confirms too; cancel leaves the app untouched', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({ role: 'editor', session: appSession() });
		const { container } = renderPage('app');
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		await user.click(screen.getByText('Stop'));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/Anyone using it will be disconnected/)).toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		expect(container.querySelector('iframe')).not.toBeNull();
	});

	// `sandbox_url` is withheld from a caller the kernel gates would reject.
	it('a running app the caller cannot reach renders the access-ended panel', async () => {
		makeFetch({ role: 'viewer', session: appSession({ sandbox_url: undefined }) });
		const { container } = renderPage('app');

		await waitFor(() => expect(screen.getByText('Access ended')).toBeInTheDocument());
		expect(screen.getByText(/no longer have access/)).toBeInTheDocument();
		expect(container.querySelector('iframe')).toBeNull();
		// The app is still serving everyone else, so a restart could only 403.
		expect(screen.queryByText('Restart app')).toBeNull();
		expect(screen.getByText('Back')).toBeInTheDocument();
	});

	it('a viewer’s 403 renders the error panel without a Retry button', async () => {
		const impl = makeFetch({
			role: 'viewer',
			createError: { code: 'FORBIDDEN', message: "Requires 'editor' role", status: 403 },
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/Requires 'editor' role/)).toBeInTheDocument());
		expect(screen.queryByText('Retry')).toBeNull();
		expect(screen.getByText('Back')).toBeInTheDocument();
		// The doomed request fired once — no loop.
		expect(sessionPosts(impl)).toHaveLength(1);
	});
});
