import { afterEach, beforeEach, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Project } from './Project';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import type { NotebookEntry, ProjectDetail, Session } from '@/types';

export const PID = 'proj-x';

export const project = (): ProjectDetail =>
	({
		id: PID,
		name: 'Sales',
		description: 'revenue',
		federation: { enabled: false },
		your_role: 'manager',
	}) as ProjectDetail;

export const notebook = (): NotebookEntry =>
	({
		id: 'nb-1',
		title: 'Forecast',
		description: '',
		tags: [],
		status: 'active',
		author: 'me',
		source_type: 'local',
		created_at: '2025-03-05T14:00:00Z',
		updated_at: '2025-03-05T14:00:00Z',
		last_run_at: null,
	}) as NotebookEntry;

export const runningSession = (): Session =>
	({
		session_id: 'sess-1',
		project_id: PID,
		notebook_id: 'nb-1',
		status: 'running',
		started_at: '2025-03-05T14:00:00Z',
		last_heartbeat: '2025-03-05T14:00:00Z',
		sandbox_url: 'https://sandbox.example/kernel',
	}) as Session;

export const stoppableSession = (): Session => ({
	...runningSession(),
	can: { attach: true, stop: true, develop: false },
});

export function makeFetch(
	options: {
		notebooks?: NotebookEntry[];
		sessions?: Session[];
		capabilities?: unknown;
		role?: ProjectDetail['your_role'];
		sessionDeleteError?: boolean;
	} = {},
) {
	const notebooks = options.notebooks ?? [notebook()];
	const sessions = options.sessions ?? [];
	const capabilities = options.capabilities ?? { federation: { available: false } };
	const proj = { ...project(), ...(options.role ? { your_role: options.role } : {}) };
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const parsedUrl = new URL(url, 'http://localhost');
		const method = init?.method ?? 'GET';
		const body =
			typeof init?.body === 'string'
				? (JSON.parse(init.body) as Record<string, unknown>)
				: undefined;
		calls.push({ url, method, body });

		if (method === 'DELETE' && url.endsWith(`/projects/${PID}`)) return jsonOk(null);
		if (method === 'PATCH' && url.endsWith(`/projects/${PID}`)) return jsonOk(project());
		if (method === 'POST' && url.endsWith(`/projects/${PID}/notebooks`))
			return jsonOk({ id: 'nb-new', title: body?.title });
		if (method === 'DELETE' && url.endsWith(`/projects/${PID}/notebooks/nb-1`)) return jsonOk(null);
		if (method === 'POST' && url.endsWith(`/projects/${PID}/notebooks/nb-1/duplicate`))
			return jsonOk({ ...notebook(), id: 'nb-copy', title: 'Forecast (copy)' });
		if (method === 'POST' && url.endsWith(`/projects/${PID}/notebooks/nb-1/sync-token/rotate`))
			return jsonOk({ sync_token: 'rotated-token' });
		if (method === 'PATCH' && url.endsWith(`/projects/${PID}/notebooks/nb-1`))
			return jsonOk({ ...notebook(), compute_profile: body?.compute_profile });
		if (method === 'PATCH' && url.endsWith(`/projects/${PID}/notebooks/nb-1/source`))
			return jsonOk({ source: body });
		if (method === 'DELETE' && url.includes(`/projects/${PID}/notebooks/nb-1/sessions/`)) {
			if (options.sessionDeleteError) return jsonError('INTERNAL_ERROR', 'restart failed');
			return jsonOk(null);
		}
		if (method === 'POST' && url.endsWith(`/projects/${PID}/notebooks/nb-1/sessions`))
			return jsonOk({
				...runningSession(),
				session_id: 'sess-restarted',
				mode: body?.mode ?? 'edit',
			});
		if (method === 'GET' && url.endsWith(`/projects/${PID}/notebooks/nb-1`))
			return jsonOk({
				meta: notebook(),
				readme: null,
				source:
					notebooks.find((entry) => entry.id === 'nb-1')?.source_type === 'git'
						? {
								type: 'git',
								provider: 'github',
								repo: 'acme/analytics',
								branch: 'main',
								root_path: 'apps',
								entry_notebook: 'dashboard.py',
								sync_mode: 'push',
								current_version_id: 'ver-1',
								commit: 'abc123',
								last_synced_at: '2025-03-05T14:00:00Z',
							}
						: { type: 'local', current_version_id: 'ver-1' },
			});
		if (method === 'GET' && url.endsWith(`/projects/${PID}/notebooks/nb-1/content`))
			return jsonOk({ code: 'print("download")' });
		if (method === 'GET' && url.endsWith(`/projects/${PID}/notebooks/nb-1/workspace.zip`))
			return new Response(new Blob(['zip']), { status: 200 });
		if (
			method === 'GET' &&
			parsedUrl.pathname.endsWith(`/projects/${PID}/notebooks/nb-1/workspace/access`)
		)
			return jsonOk({
				writable: true,
				read_only_reason: null,
				protected_paths: [
					{ path: '/notebook.py', denied_operations: ['move', 'delete'] },
					{ path: '/pyproject.toml', denied_operations: ['move', 'delete'] },
				],
			});
		if (
			method === 'GET' &&
			parsedUrl.pathname.endsWith(`/projects/${PID}/notebooks/nb-1/workspace/entries`)
		)
			return jsonOk({
				items: [
					{
						path: '/notebook.py',
						name: 'notebook.py',
						kind: 'file',
						size: 18,
						modified_at: 1_741_183_200_000,
						mime_type: 'text/x-python',
					},
				],
			});
		if (method === 'GET' && url.endsWith(`/projects/${PID}/notebooks/nb-1/html`))
			return new Response('<html>outputs</html>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			});

		if (method === 'GET' && parsedUrl.pathname.endsWith(`/projects/${PID}/notebooks`)) {
			const q = parsedUrl.searchParams.get('q')?.toLocaleLowerCase();
			const tag = parsedUrl.searchParams.get('tag');
			const status = parsedUrl.searchParams.get('status');
			const items = notebooks.filter(
				(entry) =>
					(status ? entry.status === status : entry.status !== 'deleted') &&
					(!tag || entry.tags.includes(tag)) &&
					(!q || `${entry.title} ${entry.description}`.toLocaleLowerCase().includes(q)),
			);
			return jsonOk({ items, next_cursor: null });
		}
		if (url.includes(`/projects/${PID}/sessions`))
			return jsonOk({ items: sessions, next_cursor: null });
		if (url.includes('/capabilities')) return jsonOk(capabilities);
		if (url.includes('/users')) return jsonOk({});
		if (url.endsWith(`/projects/${PID}`)) return jsonOk(proj);
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

export async function renderProject(route = `/projects/${PID}`) {
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<Project />} />
			<Route path="/projects/:pid/notebooks/:nid/snapshot" element={<div>snapshot page</div>} />
			<Route path="/" element={<div>home</div>} />
		</Routes>,
		{ route, suspenseFallback: <div>loading</div> },
	);
	await waitFor(() => expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument());
	await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Loading'));
}

export async function chooseNotebookAction(
	user: ReturnType<typeof userEvent.setup>,
	label: string,
) {
	await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
	await user.click(await screen.findByText(label));
}

export function installDownloadMocks() {
	const createObjectURL = vi.fn(() => 'blob:download');
	const revokeObjectURL = vi.fn();
	const DownloadURL = class extends URL {};
	DownloadURL.createObjectURL = createObjectURL;
	DownloadURL.revokeObjectURL = revokeObjectURL;
	vi.stubGlobal('URL', DownloadURL);
	return { createObjectURL, revokeObjectURL };
}

beforeEach(() => {
	installMatchMedia();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
