import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Project } from './Project';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
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

function makeFetch(
	options: {
		notebooks?: NotebookEntry[];
		sessions?: Session[];
		capabilities?: unknown;
	} = {},
) {
	const notebooks = options.notebooks ?? [notebook()];
	const sessions = options.sessions ?? [];
	const capabilities = options.capabilities ?? { federation: { available: false } };
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
		if (method === 'DELETE' && url.endsWith(`/projects/${PID}/notebooks/nb-1/sessions/sess-1`))
			return jsonOk(null);
		if (method === 'GET' && url.endsWith(`/projects/${PID}/notebooks/nb-1`))
			return jsonOk({
				meta: notebook(),
				readme: null,
				source: { type: 'local', current_version_id: 'ver-1' },
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
		if (url.endsWith(`/projects/${PID}`)) return jsonOk(project());
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
});

describe('Project — Delete Project (type-to-confirm)', () => {
	it('enables Delete only once the exact project name is typed, then DELETEs', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

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

	it('opens sync keys for a git-backed notebook', async () => {
		const user = userEvent.setup();
		makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		await chooseNotebookAction(user, 'Sync keys');

		expect(
			await screen.findByRole('heading', { name: 'Sync keys — Forecast' }),
		).toBeInTheDocument();
		expect(screen.getByLabelText<HTMLInputElement>('Sync URL').value).toContain(
			`/api/sync/git/v1/projects/${PID}/notebooks/nb-1`,
		);
	});

	it('rotates a sync token and shows the write-once token', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		await chooseNotebookAction(user, 'Rotate sync token');
		await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate' }));

		await waitFor(() =>
			expect(
				calls.some(
					(c) => c.method === 'POST' && c.url.endsWith('/notebooks/nb-1/sync-token/rotate'),
				),
			).toBe(true),
		);
		expect(await screen.findByLabelText('Sync token')).toHaveValue('rotated-token');
	});

	it('stops a running session from the row action', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ sessions: [runningSession()] });
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
});
