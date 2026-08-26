import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PID, makeFetch, renderProject } from './Project.testWorld';

describe('environment and access', () => {
	it('is always visible and opens the unified overview', async () => {
		makeFetch({ capabilities: { federation: { available: false } } });
		await renderProject();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Environment & cloud access' }));
		expect(screen.getByRole('heading', { name: 'Environment & cloud access' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Integrations/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Cloud access/ })).toBeInTheDocument();
	});
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
