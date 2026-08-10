import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotebookPage } from './NotebookPage';
import { ThemeProvider } from '@/context/ThemeContext';
import { sessionKeys } from '@/api/queryKeys';
import type { ProjectDetail, Session } from '@/types';

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
	role: NonNullable<ProjectDetail['your_role']>;
	viewerMode?: 'static' | 'applications' | 'ephemeral-sandbox';
	/** Body of GET .../html; null = 404 (no snapshot captured yet). */
	html?: string | null;
	session?: Session;
	/** Items served by GET /projects/{pid}/sessions (the app page's edit-activity poll). */
	projectSessions?: Session[];
	/** The notebook's current head version (staleness comparisons). */
	headVersion?: string;
	/** The notebook's source type; `git` models a GitHub-synced notebook. */
	sourceType?: 'local' | 'git';
	/** When set, POST .../sessions fails with this error code at this status. */
	createError?: { code: string; message: string; status: number };
	sessionResponses?: Session[];
	computeProfiles?: { name: string; cpu?: number; memory_bytes?: number }[];
	computeProfile?: string;
	computeProfileOverride?: 'none' | 'editors';
	editorSharing?: 'shared' | 'exclusive';
	editorOwner?: { id: string; activity: 'active' | 'idle' | 'unknown' | 'starting' };
	editorCanTakeOver?: boolean;
	editorTransfer?: 'requested' | 'draining' | 'ready';
	editorStateFailures?: number;
	editorStateFailOn?: number[];
	meFailures?: number;
	mePromise?: Promise<{
		id: string;
		email: string;
		logout_url: null;
		is_super_admin: boolean;
	}>;
}

/** Route every request the page makes to a canned response; return the fetch spy. */
function makeFetch(opts: FetchOptions) {
	let takeoverComplete = false;
	let sessionPostCount = 0;
	let editorStateRequestCount = 0;
	let meRequestCount = 0;
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (method === 'POST' && url.endsWith(`/notebooks/${NID}/editor-session/takeover`)) {
			takeoverComplete = true;
			return ok(undefined);
		}

		if (method === 'POST' && url.endsWith(`/notebooks/${NID}/sessions`)) {
			if (opts.createError) {
				const { code, message, status } = opts.createError;
				return new Response(JSON.stringify({ success: false, error: { code, message } }), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			}
			const response =
				opts.sessionResponses?.[sessionPostCount] ?? opts.session ?? runningSession();
			sessionPostCount += 1;
			return ok({ ...response, reused: false });
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
				meta: {
					id: NID,
					title: 'Forecast',
					author: 'me',
					...(opts.computeProfile ? { compute_profile: opts.computeProfile } : {}),
				},
				source:
					opts.sourceType === 'git'
						? {
								type: 'git',
								provider: 'github',
								repo: 'org/repo',
								branch: 'main',
								root_path: '',
								entry_notebook: 'app.py',
								commit: 'deadbeefcafe0123',
								last_synced_at: '2026-07-01T10:00:00Z',
								current_version_id: opts.headVersion ?? 'ver-head',
							}
						: { type: 'local', current_version_id: opts.headVersion ?? 'ver-head' },
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
				compute_profiles: opts.computeProfiles ?? [],
				compute_profile_override: opts.computeProfileOverride ?? 'none',
				editor_sandbox_sharing: opts.editorSharing ?? 'shared',
			});
		}
		if (url.endsWith('/me')) {
			meRequestCount += 1;
			if (meRequestCount <= (opts.meFailures ?? 0)) {
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'identity unavailable' },
					}),
					{ status: 503, headers: { 'content-type': 'application/json' } },
				);
			}
			return ok(
				opts.mePromise
					? await opts.mePromise
					: { id: 'me', email: 'me@example.com', logout_url: null, is_super_admin: false },
			);
		}
		if (url.endsWith(`/notebooks/${NID}/editor-session`)) {
			editorStateRequestCount += 1;
			if (
				editorStateRequestCount <= (opts.editorStateFailures ?? 0) ||
				opts.editorStateFailOn?.includes(editorStateRequestCount)
			) {
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'ownership unavailable' },
					}),
					{ status: 503, headers: { 'content-type': 'application/json' } },
				);
			}
			const owner = takeoverComplete ? undefined : opts.editorOwner;
			return ok({
				sharing: opts.editorSharing ?? 'shared',
				holder: owner
					? {
							session_id: 'sess-owner',
							user_id: owner.id,
							status: 'running',
							started_at: '2025-03-05T14:00:00Z',
							activity: { state: owner.activity },
						}
					: null,
				can_take_over: opts.editorCanTakeOver ?? !!owner,
				...(opts.editorTransfer
					? { transfer: { status: opts.editorTransfer } }
					: takeoverComplete
						? { transfer: { status: 'ready' } }
						: {}),
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
				<ThemeProvider>
					<Suspense fallback={<div>loading</div>}>{children}</Suspense>
				</ThemeProvider>
			</QueryClientProvider>
		</MemoryRouter>
	);
	const view = render(
		<Routes>
			<Route path="/projects/:pid/notebooks/:nid" element={<NotebookPage />} />
			<Route path="/projects/:pid/notebooks/:nid/app" element={<NotebookPage variant="app" />} />
		</Routes>,
		{ wrapper },
	);
	return { ...view, client };
}

const sessionPosts = (impl: ReturnType<typeof makeFetch>) =>
	impl.mock.calls.filter(
		([url, init]) => String(url).endsWith('/sessions') && init?.method === 'POST',
	);

beforeEach(() => {
	// The theme baked into the kernel iframe URL reads from localStorage; clear it
	// so each test resolves the default (light) unless it opts into dark.
	localStorage.clear();
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
	it('starts shared editing without requesting exclusive ownership state', async () => {
		const fetch = makeFetch({ role: 'editor', editorSharing: 'shared', editorStateFailures: 1 });
		renderPage();

		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
		expect(
			fetch.mock.calls.some(([url]) => String(url).endsWith(`/notebooks/${NID}/editor-session`)),
		).toBe(false);
	});

	it('asks before starting compute when another editor owns an exclusive session', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'active' },
		});
		renderPage();
		expect(await screen.findByText(/owns the saved editing session/)).toBeInTheDocument();
		expect(sessionPosts(fetch)).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Open temporary sandbox' }));
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
		expect(JSON.parse(String(sessionPosts(fetch)[0]?.[1]?.body))).toMatchObject({
			edit_intent: 'temporary',
		});
	});

	it('waits for the current user before deciding that an exclusive holder is someone else', async () => {
		let resolveMe!: (value: {
			id: string;
			email: string;
			logout_url: null;
			is_super_admin: boolean;
		}) => void;
		const mePromise = new Promise<{
			id: string;
			email: string;
			logout_url: null;
			is_super_admin: boolean;
		}>((resolve) => {
			resolveMe = resolve;
		});
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			mePromise,
		});
		renderPage();

		await waitFor(() =>
			expect(
				fetch.mock.calls.some(([url]) => String(url).endsWith(`/notebooks/${NID}/editor-session`)),
			).toBe(true),
		);
		expect(screen.queryByText(/owns the saved editing session/)).toBeNull();
		expect(sessionPosts(fetch)).toHaveLength(0);

		resolveMe({
			id: 'me',
			email: 'me@example.com',
			logout_url: null,
			is_super_admin: false,
		});
		expect(await screen.findByText(/owns the saved editing session/)).toBeInTheDocument();
	});

	it('does not classify an exclusive holder when the current-user request fails', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'me', activity: 'idle' },
			meFailures: 1,
		});
		renderPage();

		expect(
			await screen.findByText('Unable to confirm whether you own the editor sandbox.'),
		).toBeInTheDocument();
		expect(screen.queryByText(/owns the saved editing session/)).toBeNull();
		expect(sessionPosts(fetch)).toHaveLength(0);

		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
	});

	it('shows a transfer in progress without offering another takeover', async () => {
		makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			editorCanTakeOver: false,
			editorTransfer: 'draining',
		});
		renderPage();

		expect(await screen.findByText(/editing transfer is already in progress/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Takeover in progress' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Open temporary sandbox' })).toBeEnabled();
	});

	it('warns and completes an exclusive takeover before starting the replacement', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
		});
		renderPage();
		await user.click(await screen.findByRole('button', { name: 'Take over editing' }));
		expect(screen.getByText(/Their work will be saved/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Take Over' }));
		await waitFor(() =>
			expect(
				fetch.mock.calls.some(
					([url, init]) =>
						String(url).endsWith('/editor-session/takeover') && init?.method === 'POST',
				),
			).toBe(true),
		);
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
	});

	it('starts a persistent replacement after takeover from a temporary sandbox', async () => {
		const user = userEvent.setup();
		const temporary = runningSession({
			session_id: 'sess-temporary',
			ephemeral: true,
			editor_sandbox_sharing: 'exclusive',
		});
		const persistent = runningSession({
			session_id: 'sess-persistent',
			editor_sandbox_sharing: 'exclusive',
		});
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			sessionResponses: [temporary, persistent],
		});
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open temporary sandbox' }));
		await screen.findByText(/Temporary sandbox/);
		await user.click(screen.getByRole('button', { name: 'Take over editing' }));
		await user.click(screen.getByRole('button', { name: 'Take Over' }));

		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(2));
		const [temporaryPost, replacementPost] = sessionPosts(fetch);
		expect(JSON.parse(String(temporaryPost?.[1]?.body))).toMatchObject({
			edit_intent: 'temporary',
		});
		expect(replacementPost?.[1]?.body).toBeUndefined();
	});

	it('shows an ownership-state error and retries before starting compute', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorStateFailures: 1,
		});
		renderPage();

		expect(
			await screen.findByText('Unable to check who owns the editor sandbox.'),
		).toBeInTheDocument();
		expect(sessionPosts(fetch)).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
	});

	it('keeps a temporary editor visible when an ownership refresh fails', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			editorStateFailOn: [2],
			session: runningSession({ ephemeral: true, editor_sandbox_sharing: 'exclusive' }),
		});
		const { client, container } = renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open temporary sandbox' }));
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		await act(async () => {
			await client.refetchQueries({ queryKey: sessionKeys.editor(PID, NID) });
		});

		expect(
			fetch.mock.calls.filter(([url]) => String(url).endsWith('/editor-session')),
		).toHaveLength(2);
		expect(screen.queryByText('Unable to check who owns the editor sandbox.')).toBeNull();
		expect(container.querySelector('iframe')).not.toBeNull();
	});

	it('editor: starts a session and embeds the kernel iframe, no banner', async () => {
		const impl = makeFetch({ role: 'editor' });
		const { container } = renderPage();

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
			).not.toBeNull(),
		);
		expect(document.title).toBe('Forecast · marimohub');
		expect(sessionPosts(impl)).toHaveLength(1);
		expect(screen.queryByText(/won't be saved/)).toBeNull();
	});

	it('stops a viewer ephemeral session without a shared-sandbox warning', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			session: runningSession({
				ephemeral: true,
				editor_sandbox_sharing: 'shared',
			}),
		});
		renderPage();

		await screen.findByText(/session is temporary/);
		await user.click(screen.getByRole('button', { name: 'Stop' }));
		await waitFor(() =>
			expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
		);
		expect(screen.queryByText('Stop Shared Sandbox')).toBeNull();
	});

	it('uses a private restart warning for a viewer ephemeral session', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			sourceType: 'git',
			headVersion: 'ver-head',
			session: runningSession({
				ephemeral: true,
				editor_sandbox_sharing: 'shared',
				source_version_id: 'ver-old',
			}),
		});
		renderPage();

		await user.click(await screen.findByText('Restart to update'));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Restart Session')).toBeInTheDocument();
		expect(within(dialog).queryByText(/All connected editors/)).toBeNull();
	});

	it('dark theme: forces the embedded app onto ?theme=dark', async () => {
		localStorage.setItem('marimohub-theme', 'dark');
		makeFetch({ role: 'editor' });
		const { container } = renderPage();

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=dark"]'),
			).not.toBeNull(),
		);
	});

	it('shows the selected compute profile in the header', async () => {
		makeFetch({
			role: 'editor',
			session: runningSession({ compute_profile: 'large' }),
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
			],
		});
		renderPage();

		expect(await screen.findByText('large — 8 CPU · 32 Gi')).toBeInTheDocument();
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
		expect(
			container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
		).not.toBeNull();
		expect(sessionPosts(impl)).toHaveLength(1);
	});
});

describe('NotebookPage git-synced editor', () => {
	const gitEditSession = (overrides: Partial<Session> = {}) =>
		runningSession({ source_version_id: 'ver-head', ...overrides });

	it('shows the updated-on-GitHub banner when the session trails the head', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		renderPage();

		await waitFor(() =>
			expect(screen.getByText(/updated in its git repository/)).toBeInTheDocument(),
		);
		expect(screen.getByText('Restart to update')).toBeInTheDocument();
	});

	it('shows no banner when the session serves the synced head', async () => {
		makeFetch({ role: 'editor', sourceType: 'git', session: gitEditSession() });
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByText(/updated in its git repository/)).toBeNull();
	});

	it('header shows the repo chip whose popover links to the source on GitHub', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'editor', sourceType: 'git', session: gitEditSession() });
		renderPage();

		await user.click(
			await screen.findByRole('button', { name: 'Synced from a git repository — details' }),
		);
		const popover = await screen.findByRole('dialog');
		expect(within(popover).getByRole('link', { name: 'org/repo' })).toHaveAttribute(
			'href',
			'https://github.com/org/repo',
		);
		expect(within(popover).getByRole('link', { name: 'deadbee' })).toHaveAttribute(
			'href',
			'https://github.com/org/repo/commit/deadbeefcafe0123',
		);
		expect(within(popover).getByRole('link', { name: /View source on GitHub/ })).toHaveAttribute(
			'href',
			'https://github.com/org/repo/blob/deadbeefcafe0123/app.py',
		);
	});

	it('the app view shows no repo chip', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({ mode: 'app' }),
		});
		const { container } = renderPage('app');

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(
			screen.queryByRole('button', { name: 'Synced from a git repository — details' }),
		).toBeNull();
	});

	it('shows the banner without a restart CTA when the caller cannot stop the session', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({
				source_version_id: 'ver-old',
				can: { attach: true, stop: false },
			}),
			headVersion: 'ver-head',
		});
		renderPage();

		await waitFor(() =>
			expect(screen.getByText(/updated in its git repository/)).toBeInTheDocument(),
		);
		expect(screen.queryByText('Restart to update')).toBeNull();
	});

	it('shows no banner on a local notebook even when versions differ', async () => {
		makeFetch({
			role: 'editor',
			session: gitEditSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByText(/updated in its git repository/)).toBeNull();
	});

	it('Restart to update confirms (cancel is a no-op), then tears down and starts fresh', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		const { container } = renderPage();
		await waitFor(() => expect(screen.getByText('Restart to update')).toBeInTheDocument());

		await user.click(screen.getByText('Restart to update'));
		// The dialog, not a teardown, is what a click produces.
		expect(sessionPosts(impl)).toHaveLength(1);
		let dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/latest synced version/)).toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		expect(container.querySelector('iframe')).not.toBeNull();

		await user.click(screen.getByText('Restart to update'));
		dialog = await screen.findByRole('dialog');
		await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
		await waitFor(() => expect(sessionPosts(impl)).toHaveLength(2));
		const deletes = impl.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deletes).toHaveLength(1);
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
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
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

	it('does not suppress the staleness banner for a temporary editor', async () => {
		makeFetch({
			role: 'editor',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
			projectSessions: [runningSession({ session_id: 'sess-edit', mode: 'edit', ephemeral: true })],
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
	});

	it('does not suppress the banner during editing on a git-synced notebook', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
			projectSessions: [runningSession({ session_id: 'sess-edit', mode: 'edit' })],
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
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
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
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
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8 },
			],
			createError: { code: 'FORBIDDEN', message: "Requires 'editor' role", status: 403 },
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/Requires 'editor' role/)).toBeInTheDocument());
		expect(screen.queryByText('Retry')).toBeNull();
		expect(screen.queryByText('Retry with Default')).toBeNull();
		expect(screen.getByText('Back')).toBeInTheDocument();
		// The doomed request fired once — no loop.
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('does not offer a Default bypass for a failed shared app', async () => {
		makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8 },
			],
			createError: {
				code: 'RESOURCE_EXHAUSTED',
				message: 'No nodes can schedule this profile',
				status: 429,
			},
		});
		renderPage('app');

		expect(await screen.findByText('No nodes can schedule this profile')).toBeInTheDocument();
		expect(screen.queryByText('Retry with Default')).toBeNull();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('offers a one-shot Retry with Default without replacing the stored profile', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({
			role: 'editor',
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8 },
			],
			createError: {
				code: 'RESOURCE_EXHAUSTED',
				message: 'No nodes can schedule this profile',
				status: 429,
			},
		});
		renderPage();

		expect(await screen.findByText('No nodes can schedule this profile')).toBeInTheDocument();
		expect(screen.queryByText(/a larger profile may be needed/)).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry with Default' }));

		await waitFor(() => expect(sessionPosts(impl)).toHaveLength(2));
		const retryBody = sessionPosts(impl)[1][1]?.body;
		expect(JSON.parse(String(retryBody))).toEqual({ compute_profile: 'default' });
		expect(screen.queryByRole('button', { name: 'Retry with Default' })).toBeNull();
	});
});
