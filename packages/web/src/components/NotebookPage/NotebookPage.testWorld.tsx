import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotebookPage } from './NotebookPage';
import { ThemeProvider } from '@/context/ThemeContext';
import type { ProjectDetail, Session } from '@/types';

export const PID = 'proj-x';
export const NID = 'nb-1';

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

export function changeRequestBody(init?: RequestInit): { target_proposal_id?: string } {
	return JSON.parse(String(init?.body ?? '{}')) as { target_proposal_id?: string };
}

export function runningSession(overrides: Partial<Session> = {}): Session {
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
	entryNotebook?: string;
	notebookPromise?: Promise<void>;
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
	sourceControlProviders?: string[];
	vscode?: { embed: 'tab' | 'iframe' };
	opencode?: { embed: 'tab' | 'iframe' };
	vscodeStartError?: { code: string; message: string; status: number };
	vscodeStopError?: { code: string; message: string; status: number };
	opencodeStartError?: { code: string; message: string; status: number };
	opencodeStopError?: { code: string; message: string; status: number };
	omitSourceControlCapability?: boolean;
	changeRequestFailures?: number;
	changeRequestFailOn?: number[];
	changeRequestFailure?: { code: string; message: string; status: number };
	mePromise?: Promise<{
		id: string;
		email: string;
		logout_url: null;
		is_super_admin: boolean;
	}>;
}

/** Route every request the page makes to a canned response; return the fetch spy. */
export function makeFetch(opts: FetchOptions) {
	let takeoverComplete = false;
	let sessionPostCount = 0;
	let editorStateRequestCount = 0;
	let meRequestCount = 0;
	let changeRequestCount = 0;
	let successfulChangeRequestCount = 0;
	let nextChangeRequestNumber = 17;
	const publications = new Map<
		string,
		{ provider: string; number: number; url: string; head_branch: string; head_commit: string }
	>();
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
		if (method === 'POST' && url.endsWith('/surfaces/vscode')) {
			if (opts.vscodeStartError) {
				const { code, message, status } = opts.vscodeStartError;
				return new Response(JSON.stringify({ success: false, error: { code, message } }), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			}
			return ok({
				id: 'vscode',
				status: 'ready',
				url: 'https://vscode.example/?folder=/workspace',
			});
		}
		if (method === 'POST' && url.endsWith('/surfaces/opencode')) {
			if (opts.opencodeStartError) {
				const { code, message, status } = opts.opencodeStartError;
				return new Response(JSON.stringify({ success: false, error: { code, message } }), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			}
			return ok({
				id: 'opencode',
				status: 'ready',
				url: 'https://opencode.example/',
			});
		}
		if (method === 'DELETE' && url.endsWith('/surfaces/vscode')) {
			if (opts.vscodeStopError) {
				const { code, message, status } = opts.vscodeStopError;
				return new Response(JSON.stringify({ success: false, error: { code, message } }), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			}
			return ok(undefined);
		}
		if (method === 'DELETE' && url.endsWith('/surfaces/opencode')) {
			if (opts.opencodeStopError) {
				const { code, message, status } = opts.opencodeStopError;
				return new Response(JSON.stringify({ success: false, error: { code, message } }), {
					status,
					headers: { 'content-type': 'application/json' },
				});
			}
			return ok(undefined);
		}
		if (method === 'POST' && url.endsWith('/change-requests')) {
			changeRequestCount += 1;
			if (
				changeRequestCount <= (opts.changeRequestFailures ?? 0) ||
				opts.changeRequestFailOn?.includes(changeRequestCount)
			) {
				const failure = opts.changeRequestFailure ?? {
					code: 'SERVICE_UNAVAILABLE',
					message: 'GitHub is unavailable',
					status: 503,
				};
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: failure.code, message: failure.message },
					}),
					{ status: failure.status, headers: { 'content-type': 'application/json' } },
				);
			}
			successfulChangeRequestCount += 1;
			const proposalId = `prop-${successfulChangeRequestCount}234567890abcdef`;
			const body = changeRequestBody(init);
			const target = body.target_proposal_id
				? publications.get(body.target_proposal_id)
				: undefined;
			const number = target?.number ?? nextChangeRequestNumber++;
			const changeRequest = {
				provider: 'github',
				number,
				url: `https://github.com/org/repo/pull/${number}`,
				head_branch: target?.head_branch ?? `marimohub/nb-1/${proposalId}`,
				head_commit: `head-${successfulChangeRequestCount}`,
			};
			publications.set(proposalId, changeRequest);
			return ok({ proposal_id: proposalId, change_request: changeRequest });
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
			await opts.notebookPromise;
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
								entry_notebook: opts.entryNotebook ?? 'app.py',
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
				...(opts.omitSourceControlCapability
					? {}
					: {
							source_control: {
								change_request_providers: opts.sourceControlProviders ?? [],
							},
						}),
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
				surfaces: [
					...(opts.vscode
						? [
								{
									id: 'vscode' as const,
									flavor: 'code-server' as const,
									start: 'on-demand' as const,
									embed: opts.vscode.embed,
								},
							]
						: []),
					...(opts.opencode
						? [
								{
									id: 'opencode' as const,
									start: 'on-demand' as const,
									embed: opts.opencode.embed,
									managed_ai: true,
								},
							]
						: []),
				],
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

export function renderPage(variant: 'edit' | 'app' = 'edit') {
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

export const sessionPosts = (impl: ReturnType<typeof makeFetch>) =>
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
