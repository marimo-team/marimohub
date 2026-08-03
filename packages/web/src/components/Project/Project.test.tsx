import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { toast } from 'sonner';
import { Project } from './Project';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import type { NotebookEntry, ProjectDetail, Session } from '@/types';

const PID = 'proj-x';

const project = (): ProjectDetail =>
	({
		id: PID,
		name: 'Sales',
		description: 'revenue',
		federation: { enabled: false },
	}) as ProjectDetail;

const notebook = (): NotebookEntry =>
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

const runningSession = (): Session =>
	({
		session_id: 'sess-1',
		project_id: PID,
		notebook_id: 'nb-1',
		status: 'running',
		started_at: '2025-03-05T14:00:00Z',
		last_heartbeat: '2025-03-05T14:00:00Z',
		sandbox_url: 'https://sandbox.example/kernel',
	}) as Session;

const stoppableSession = (): Session => ({
	...runningSession(),
	can: { attach: true, stop: true },
});

function makeFetch(
	options: {
		notebooks?: NotebookEntry[];
		sessions?: Session[];
		capabilities?: unknown;
		role?: 'admin' | 'editor' | 'viewer';
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
		const method = init?.method ?? 'GET';
		const body = init?.body
			? (JSON.parse(init.body as string) as Record<string, unknown>)
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

		if (url.includes(`/projects/${PID}/notebooks`))
			return jsonOk({ items: notebooks, next_cursor: null });
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

async function renderProject() {
	renderWithClient(
		<Routes>
			<Route path="/projects/:pid" element={<Project />} />
			<Route path="/" element={<div>home</div>} />
		</Routes>,
		{ route: `/projects/${PID}`, suspenseFallback: <div>loading</div> },
	);
	await waitFor(() => expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument());
}

async function chooseNotebookAction(user: ReturnType<typeof userEvent.setup>, label: string) {
	await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
	await user.click(await screen.findByText(label));
}

function installDownloadMocks() {
	const createObjectURL = vi.fn(() => 'blob:download');
	const revokeObjectURL = vi.fn();
	vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
	return { createObjectURL, revokeObjectURL };
}

beforeEach(() => {
	installMatchMedia();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Project — Delete Project (type-to-confirm)', () => {
	it('enables Delete only once the exact project name is typed, then DELETEs', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		expect(document.title).toBe('Sales · marimohub');
		await user.click(screen.getByRole('button', { name: 'Delete project' }));
		const dialog = screen.getByRole('dialog');
		const confirm = within(dialog).getByRole('button', { name: 'Delete' });
		expect(confirm).toBeDisabled();

		const field = within(dialog).getByLabelText(/Type "Sales" to confirm/);
		await user.type(field, 'Sale');
		expect(confirm).toBeDisabled();

		await user.type(field, 's');
		expect(confirm).toBeEnabled();

		await user.click(confirm);
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/projects/${PID}`))).toBe(
				true,
			),
		);
		await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
	});
});

describe('Project — Edit Project', () => {
	it('seeds the current values and PATCHes the edited name', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Edit project' }));
		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByLabelText('Project Name')).toHaveValue('Sales');
		expect(within(dialog).getByLabelText('Description')).toHaveValue('revenue');

		const name = within(dialog).getByLabelText('Project Name');
		await user.clear(name);
		expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

		await user.type(name, 'Sales EMEA');
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			const patch = calls.find((c) => c.method === 'PATCH');
			expect(patch?.body).toMatchObject({ name: 'Sales EMEA', description: 'revenue' });
		});
	});
});

describe('Project — Create Notebook', () => {
	it('POSTs a template notebook when no file is uploaded', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'New Notebook' }));
		const dialog = screen.getByRole('dialog');
		await user.type(within(dialog).getByLabelText('Notebook Name'), 'Churn');
		await user.click(within(dialog).getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.url).toContain(`/projects/${PID}/notebooks`);
			expect(post?.body).toMatchObject({ title: 'Churn', description: 'Churn' });
			const code = (post?.body as { code?: string } | undefined)?.code;
			expect(code).toContain('import marimo');
			expect(code).toContain('marimo.App(width="medium", sql_output="native")');
			expect(code).toContain('mo.md("# Churn")');
		});
	});

	it('quotes the notebook name safely in the generated Python', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'New Notebook' }));
		const dialog = screen.getByRole('dialog');
		await user.type(within(dialog).getByLabelText('Notebook Name'), 'Quote"""Break');
		await user.click(within(dialog).getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			const post = calls.find((call) => call.method === 'POST');
			const code = (post?.body as { code?: string } | undefined)?.code;
			expect(code).toContain('mo.md("# Quote\\\"\\\"\\\"Break")');
			expect(code).not.toContain('r"""');
		});
	});

	it('stores the selected compute profile when creating a notebook', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({
			role: 'editor',
			capabilities: {
				federation: { available: false },
				compute_profiles: [
					{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
					{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
				],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'New Notebook' }));
		const dialog = screen.getByRole('dialog');
		await user.type(within(dialog).getByLabelText('Notebook Name'), 'Churn');
		await user.click(within(dialog).getByRole('radio', { name: /large/ }));
		await user.click(within(dialog).getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			const post = calls.find(
				(call) => call.method === 'POST' && call.url.endsWith(`/projects/${PID}/notebooks`),
			);
			expect(post?.body).toMatchObject({ compute_profile: 'large' });
		});
	});

	it('uploads a .py file, auto-fills the name, and POSTs the file contents', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'New Notebook' }));
		const dialog = screen.getByRole('dialog');
		const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(['print("hi from file")'], 'analysis.py', { type: 'text/x-python' });
		await user.upload(fileInput, file);

		await waitFor(() =>
			expect(within(dialog).getByLabelText('Notebook Name')).toHaveValue('analysis'),
		);

		await user.click(within(dialog).getByRole('button', { name: 'Create' }));
		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			const code = (post?.body as { code?: string } | undefined)?.code;
			expect(code).toBe('print("hi from file")');
		});
	});

	it('rejects a file over the size limit and does not POST', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'New Notebook' }));
		const dialog = screen.getByRole('dialog');
		const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		const tooBig = new File([new Uint8Array(1_000_001)], 'big.py', { type: 'text/x-python' });
		await user.upload(fileInput, tooBig);

		expect(await screen.findByText(/too large/i)).toBeInTheDocument();
		expect(within(dialog).getByLabelText('Notebook Name')).toHaveValue('');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});
});

describe('Project — Notebook Actions', () => {
	it('groups related notebook actions with separators', async () => {
		const user = userEvent.setup();
		makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		const menu = await screen.findByRole('menu');

		expect(within(menu).getAllByRole('separator')).toHaveLength(4);
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((item) => item.textContent),
		).toEqual([
			'Rename',
			'Duplicate',
			'Run as app',
			'Version history',
			'Download notebook file',
			'Download workspace',
			'Delete',
		]);
	});

	it('deletes a notebook only after confirmation', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await chooseNotebookAction(user, 'Delete');
		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText(/delete "Forecast"/i)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/notebooks/nb-1'))).toBe(
			false,
		);

		await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/notebooks/nb-1'))).toBe(
				true,
			),
		);
	});

	it('offers "Change base image" only when the deployment lists multiple images', async () => {
		const user = userEvent.setup();
		makeFetch({
			capabilities: {
				federation: { available: false },
				sandbox_images: ['img-a', 'img-b'],
			},
		});
		await renderProject();

		await chooseNotebookAction(user, 'Change base image');
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Change Base Image')).toBeInTheDocument();
		// Default + one option per configured image.
		expect(await within(dialog).findByRole('radio', { name: /Default/ })).toBeInTheDocument();
		expect(within(dialog).getByRole('radio', { name: 'img-b' })).toBeInTheDocument();
	});

	it('hides "Change base image" when only one image is configured', async () => {
		const user = userEvent.setup();
		makeFetch({
			capabilities: { federation: { available: false }, sandbox_images: ['img-a'] },
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Rename')).toBeInTheDocument();
		expect(screen.queryByText('Change base image')).not.toBeInTheDocument();
	});

	it('does not clutter the notebook list when there is only one compute profile', async () => {
		makeFetch({
			capabilities: {
				federation: { available: false },
				compute_profiles: [{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 }],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		expect(screen.queryByText('small')).not.toBeInTheDocument();
	});

	it('lets editors change compute from the notebook overflow menu', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({
			role: 'editor',
			capabilities: {
				federation: { available: false },
				compute_profiles: [
					{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
					{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
				],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		await chooseNotebookAction(user, 'Change compute…');
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByRole('radio', { name: /Default \(small\)/ })).toBeChecked();
		await user.click(within(dialog).getByRole('radio', { name: /large/ }));
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(
				calls.some(
					(call) =>
						call.method === 'PATCH' &&
						call.url.endsWith('/notebooks/nb-1') &&
						(call.body as { compute_profile?: string })?.compute_profile === 'large',
				),
			).toBe(true),
		);
	});

	it('labels and restarts the edit session when edit and app are both live', async () => {
		const user = userEvent.setup();
		const toastSuccess = vi.spyOn(toast, 'success');
		const calls = makeFetch({
			role: 'editor',
			sessions: [
				{
					...runningSession(),
					session_id: 'sess-edit',
					mode: 'edit',
					can: { attach: true, stop: true },
				} as Session,
				{
					...runningSession(),
					session_id: 'sess-app',
					mode: 'app',
					can: { attach: true, stop: true },
				} as Session,
			],
			capabilities: {
				federation: { available: false },
				compute_profiles: [
					{ name: 'small', cpu: 1 },
					{ name: 'large', cpu: 8 },
				],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		await chooseNotebookAction(user, 'Change compute…');
		const dialog = await screen.findByRole('dialog');
		await user.click(within(dialog).getByRole('radio', { name: /large/ }));
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));
		await user.click(await screen.findByRole('button', { name: 'Restart edit session' }));

		await waitFor(() =>
			expect(
				calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/sessions/sess-edit')),
			).toBe(true),
		);
		expect(calls.some((call) => call.url.endsWith('/sessions/sess-app'))).toBe(false);
		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith('Restarted the session for "Forecast"');
		});
	});

	it('keeps the app stale hint visible when only a temporary editor is running', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'editor',
			sessions: [
				{
					...runningSession(),
					session_id: 'sess-temporary',
					mode: 'edit',
					ephemeral: true,
					can: { attach: true, stop: true },
				} as Session,
				{
					...runningSession(),
					session_id: 'sess-app',
					mode: 'app',
					source_version_id: 'ver-old',
					can: { attach: true, stop: true },
				} as Session,
			],
		});
		await renderProject();

		await user.click(await screen.findByRole('button', { name: 'App running — details' }));
		expect(await screen.findByText(/Restart to update/)).toBeInTheDocument();
	});

	it('surfaces an edit-session restart failure from the compute toast', async () => {
		const user = userEvent.setup();
		const toastError = vi.spyOn(toast, 'error');
		const calls = makeFetch({
			role: 'editor',
			sessionDeleteError: true,
			sessions: [
				{
					...runningSession(),
					mode: 'edit',
					can: { attach: true, stop: true },
				} as Session,
			],
			capabilities: {
				federation: { available: false },
				compute_profiles: [{ name: 'small' }, { name: 'large' }],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		await chooseNotebookAction(user, 'Change compute…');
		const dialog = await screen.findByRole('dialog');
		await user.click(within(dialog).getByRole('radio', { name: /large/ }));
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));
		await user.click(await screen.findByRole('button', { name: 'Restart session' }));

		await waitFor(() => {
			expect(
				calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/sessions/sess-1')),
			).toBe(true);
			expect(toastError).toHaveBeenCalledWith('restart failed');
		});
	});

	it('hides the change-compute action when overrides are disabled', async () => {
		const user = userEvent.setup();
		makeFetch({
			capabilities: {
				federation: { available: false },
				compute_profiles: [{ name: 'small' }, { name: 'large' }],
				compute_profile_override: 'none',
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Rename')).toBeInTheDocument();
		expect(screen.queryByText('Change compute…')).not.toBeInTheDocument();
	});

	it('duplicates a notebook from the overflow menu', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await chooseNotebookAction(user, 'Duplicate');

		await waitFor(() =>
			expect(
				calls.some((c) => c.method === 'POST' && c.url.endsWith('/notebooks/nb-1/duplicate')),
			).toBe(true),
		);
	});

	it('downloads the notebook source file', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		const { createObjectURL, revokeObjectURL } = installDownloadMocks();
		await renderProject();

		await chooseNotebookAction(user, 'Download notebook file');

		await waitFor(() =>
			expect(
				calls.some((c) => c.method === 'GET' && c.url.endsWith('/notebooks/nb-1/content')),
			).toBe(true),
		);
		expect(createObjectURL).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
	});

	it('downloads the notebook workspace archive', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		const { createObjectURL } = installDownloadMocks();
		await renderProject();

		await chooseNotebookAction(user, 'Download workspace');

		await waitFor(() =>
			expect(
				calls.some((c) => c.method === 'GET' && c.url.endsWith('/notebooks/nb-1/workspace.zip')),
			).toBe(true),
		);
		expect(createObjectURL).toHaveBeenCalledOnce();
	});

	it('offers one unified sync settings action for a git-backed notebook', async () => {
		const user = userEvent.setup();
		makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Sync settings')).toBeInTheDocument();
		expect(screen.queryByText('Sync keys')).not.toBeInTheDocument();
		expect(screen.queryByText('Rotate sync token')).not.toBeInTheDocument();
		await user.click(screen.getByText('Sync settings'));

		expect(
			await screen.findByRole('heading', { name: 'Sync settings — Forecast' }),
		).toBeInTheDocument();
		expect(await screen.findByLabelText('Repository')).toHaveValue('acme/analytics');
		expect(screen.getByLabelText<HTMLInputElement>('Sync URL').value).toContain(
			`/api/sync/git/v1/projects/${PID}/notebooks/nb-1`,
		);
	});

	it("a git row's source tile opens a popover with GitHub links", async () => {
		const user = userEvent.setup();
		makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		const trigger = screen.getByRole('button', { name: 'Synced from GitHub — details' });
		// Outside the row anchor — RowLink's no-buttons-in-<a> invariant.
		expect(trigger.closest('a')).toBeNull();
		await user.click(trigger);
		const popover = await screen.findByRole('dialog');
		expect(within(popover).getByRole('link', { name: 'acme/analytics' })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics',
		);
		expect(within(popover).getByText('apps/dashboard.py')).toBeInTheDocument();
		expect(within(popover).getByRole('link', { name: /View source on GitHub/ })).toHaveAttribute(
			'href',
			'https://github.com/acme/analytics/blob/abc123/apps/dashboard.py',
		);
	});

	it('rotates a sync token and shows the write-once token', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		await chooseNotebookAction(user, 'Sync settings');
		await user.click(await screen.findByRole('button', { name: 'Rotate token' }));
		await user.click(screen.getByRole('button', { name: 'Rotate' }));

		await waitFor(() =>
			expect(
				calls.some(
					(c) => c.method === 'POST' && c.url.endsWith('/notebooks/nb-1/sync-token/rotate'),
				),
			).toBe(true),
		);
		expect(await screen.findByLabelText('Sync token')).toHaveValue('rotated-token');
	});

	it('viewer + applications: may open the running app but not stop it', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'viewer',
			sessions: [
				{
					...runningSession(),
					session_id: 'sess-app',
					mode: 'app',
					can: { attach: true, stop: false },
				} as Session,
			],
			capabilities: {
				federation: { available: false },
				viewer_mode: 'applications',
				viewer_session_modes: ['app'],
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Open app')).toBeInTheDocument();
		expect(screen.queryByText('Stop app')).toBeNull();
	});

	it('viewer + applications: may start the app when none is running', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'viewer',
			capabilities: {
				federation: { available: false },
				viewer_mode: 'applications',
				viewer_session_modes: ['app'],
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Run as app')).toBeInTheDocument();
	});

	it('viewer + static: no app actions in the menu', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'viewer',
			sessions: [
				{
					...runningSession(),
					session_id: 'sess-app',
					mode: 'app',
					can: { attach: false, stop: false },
				} as Session,
			],
			capabilities: {
				federation: { available: false },
				viewer_mode: 'static',
				viewer_session_modes: [],
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Rename')).toBeInTheDocument();
		expect(screen.queryByText('Open app')).toBeNull();
		expect(screen.queryByText('Run as app')).toBeNull();
		expect(screen.queryByText('Stop app')).toBeNull();
	});

	it('editor keeps Open app + Stop app on a running app', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'editor',
			sessions: [
				{
					...runningSession(),
					session_id: 'sess-app',
					mode: 'app',
					can: { attach: true, stop: true },
				} as Session,
			],
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(await screen.findByText('Open app')).toBeInTheDocument();
		expect(screen.getByText('Stop app')).toBeInTheDocument();
	});

	it('stops a running session from the row action', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ sessions: [stoppableSession()] });
		await renderProject();

		await user.click(await screen.findByRole('button', { name: 'Shut down kernel' }));
		await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Shut Down' }));

		await waitFor(() =>
			expect(
				calls.some(
					(c) => c.method === 'DELETE' && c.url.endsWith('/notebooks/nb-1/sessions/sess-1'),
				),
			).toBe(true),
		);
	});

	it('stops a running session from the notebook menu', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ sessions: [stoppableSession()] });
		await renderProject();

		await chooseNotebookAction(user, 'Shut down kernel');
		await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Shut Down' }));

		await waitFor(() =>
			expect(
				calls.some(
					(c) => c.method === 'DELETE' && c.url.endsWith('/notebooks/nb-1/sessions/sess-1'),
				),
			).toBe(true),
		);
	});

	it('hides kernel shutdown actions without the session stop grant', async () => {
		const user = userEvent.setup();
		makeFetch({ sessions: [runningSession()] });
		await renderProject();

		expect(screen.queryByRole('button', { name: 'Shut down kernel' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		expect(screen.queryByRole('menuitem', { name: 'Shut down kernel' })).not.toBeInTheDocument();
	});
});
