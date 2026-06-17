import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { Project } from './Project';
import type { NotebookEntry, ProjectDetail } from '@/types';

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

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Route every request the Project page makes to a canned response, recording the
 * mutating calls so tests can assert on them.
 */
function makeFetch() {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body
			? (JSON.parse(init.body as string) as Record<string, unknown>)
			: undefined;
		if (method !== 'GET') calls.push({ url, method, body });

		if (method === 'DELETE' && url.endsWith(`/projects/${PID}`)) return ok(null);
		if (method === 'PATCH' && url.endsWith(`/projects/${PID}`)) return ok(project());
		if (method === 'POST' && url.endsWith(`/projects/${PID}/notebooks`))
			return ok({ id: 'nb-new', title: body?.title });

		if (url.includes(`/projects/${PID}/notebooks`))
			return ok({ items: [notebook()], next_cursor: null });
		if (url.includes(`/projects/${PID}/sessions`)) return ok({ items: [], next_cursor: null });
		if (url.includes('/capabilities')) return ok({ federation: { available: false } });
		if (url.includes('/users')) return ok({});
		if (url.endsWith(`/projects/${PID}`)) return ok(project());
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

async function renderProject() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[`/projects/${PID}`]}>
			<QueryClientProvider client={client}>
				<Suspense fallback={<div>loading</div>}>{children}</Suspense>
				<Toaster />
			</QueryClientProvider>
		</MemoryRouter>
	);
	render(
		<Routes>
			<Route path="/projects/:pid" element={<Project />} />
			<Route path="/" element={<div>home</div>} />
		</Routes>,
		{ wrapper },
	);
	await waitFor(() => expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument());
}

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
		// Navigates home on success.
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

		await user.click(screen.getByRole('button', { name: '+ New Notebook' }));
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

		await user.click(screen.getByRole('button', { name: '+ New Notebook' }));
		const dialog = screen.getByRole('dialog');
		const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(['print("hi from file")'], 'analysis.py', { type: 'text/x-python' });
		await user.upload(fileInput, file);

		// Name auto-fills from the file name (sans extension).
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

		await user.click(screen.getByRole('button', { name: '+ New Notebook' }));
		const dialog = screen.getByRole('dialog');
		const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement;
		const tooBig = new File([new Uint8Array(1_000_001)], 'big.py', { type: 'text/x-python' });
		await user.upload(fileInput, tooBig);

		expect(await screen.findByText(/too large/i)).toBeInTheDocument();
		expect(within(dialog).getByLabelText('Notebook Name')).toHaveValue('');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});
});
