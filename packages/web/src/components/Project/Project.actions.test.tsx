import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { setupUser } from '@/test/render';
import { chooseNotebookAction, makeFetch, notebook, renderProject } from './Project.testWorld';

describe('Project — Notebook Actions: configuration', () => {
	it('groups related notebook actions with separators', async () => {
		const user = setupUser();
		makeFetch();
		await renderProject();

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		const menu = await screen.findByRole('menu');

		expect(within(menu).getAllByRole('separator')).toHaveLength(4);
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((item) => item.textContent),
		).toEqual([
			'Rename',
			'Edit thumbnail',
			'Duplicate',
			'Move to project…',
			'Run as app',
			'Browse files',
			'View static outputs',
			'Version history',
			'Jobs & schedules',
			'Download notebook file',
			'Download outputs (HTML)',
			'Download workspace',
			'Delete',
		]);
	});

	it.each([
		['git', false],
		['git', true],
		['local', true],
	] as const)(
		'offers previews for %s notebooks with the integration enabled: %s',
		async (sourceType, enabled) => {
			const user = setupUser();
			makeFetch({
				notebooks: [{ ...notebook(), source_type: sourceType }],
				capabilities: { source_control: { preview_providers: enabled ? ['github'] : [] } },
			});
			await renderProject();
			await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
			await screen.findByRole('menu');
			if (enabled && sourceType === 'git')
				expect(await screen.findByRole('menuitem', { name: 'Previews' })).toBeInTheDocument();
			else expect(screen.queryByRole('menuitem', { name: 'Previews' })).not.toBeInTheDocument();
		},
	);

	it('opens the persisted workspace browser from the notebook menu', async () => {
		const user = setupUser();
		makeFetch();
		await renderProject();

		await chooseNotebookAction(user, 'Browse files');

		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Browse files · Forecast')).toBeInTheDocument();
		expect(
			within(dialog).queryByText(/notebook.py and pyproject.toml can be edited/),
		).not.toBeInTheDocument();
		expect(await within(dialog).findAllByText('notebook.py')).toHaveLength(2);
	});

	it('shows hidden entries, working layout toggles, metadata, and icon tooltips', async () => {
		const user = setupUser();
		makeFetch({
			workspaceEntries: {
				'/': [
					{
						path: '/.gitignore',
						name: '.gitignore',
						kind: 'file',
						size: 12,
						modified_at: 1_741_183_200_000,
						mime_type: 'text/plain',
					},
					{
						path: '/notebook.py',
						name: 'notebook.py',
						kind: 'file',
						size: 18,
						modified_at: 1_741_183_200_000,
						mime_type: 'text/x-python',
					},
				],
			},
		});
		await renderProject();
		await chooseNotebookAction(user, 'Browse files');

		const dialog = await screen.findByRole('dialog');
		const tree = await within(dialog).findByRole('treegrid', { name: 'Workspace tree' });
		expect(await within(tree).findByText('.gitignore')).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'List view' })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		expect(within(dialog).getByRole('button', { name: 'List view' }).parentElement).toHaveAttribute(
			'title',
			'List view',
		);
		expect(within(dialog).getByRole('button', { name: 'Back' }).parentElement).toHaveAttribute(
			'title',
			'Back',
		);

		expect(within(dialog).getByRole('button', { name: 'Refresh' })).toHaveAccessibleName('Refresh');

		await user.click(within(dialog).getByRole('button', { name: 'Table view' }));
		expect(within(dialog).getByRole('button', { name: 'Table view' })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		const table = await within(dialog).findByRole('grid', { name: 'Workspace files' });
		expect(within(table).getByRole('columnheader', { name: /Name/ })).toBeInTheDocument();
		expect(within(table).getByRole('columnheader', { name: /Type/ })).toBeInTheDocument();
		expect(within(table).getByText('text/x-python')).toBeInTheDocument();
		expect(within(table).getByText('18 B')).toBeInTheDocument();
	});

	it('navigates a sidebar file to its parent and keeps the file selected', async () => {
		const user = setupUser();
		const calls = makeFetch({
			workspaceEntries: {
				'/': [{ path: '/data', name: 'data', kind: 'directory' }],
				'/data': [
					{
						path: '/data/analysis.py',
						name: 'analysis.py',
						kind: 'file',
						size: 24,
						modified_at: 1_741_183_200_000,
						mime_type: 'text/x-python',
					},
				],
			},
		});
		await renderProject();
		await chooseNotebookAction(user, 'Browse files');

		const dialog = await screen.findByRole('dialog');
		const tree = await within(dialog).findByRole('treegrid', { name: 'Workspace tree' });
		const expand = tree.querySelector<HTMLButtonElement>('button[slot="chevron"]');
		expect(expand).not.toBeNull();
		await user.click(expand!);
		await user.click(await within(tree).findByText('analysis.py'));

		await waitFor(() => expect(within(dialog).getByText('/data')).toBeInTheDocument());
		expect(within(dialog).queryByText('This folder is empty.')).not.toBeInTheDocument();
		expect(
			calls.some((call) => {
				const url = new URL(call.url, 'http://localhost');
				return (
					url.pathname.endsWith('/workspace/entries') &&
					url.searchParams.get('path') === '/data/analysis.py'
				);
			}),
		).toBe(false);
		const content = within(dialog).getByRole('grid', { name: 'Workspace files' });
		expect(within(content).getByRole('row', { name: /analysis.py/ })).toHaveAttribute(
			'data-selected',
			'true',
		);
	});

	it('keeps the shared file Open action enabled', async () => {
		const user = setupUser();
		makeFetch();
		await renderProject();
		await chooseNotebookAction(user, 'Browse files');

		const dialog = await screen.findByRole('dialog');
		const content = await within(dialog).findByRole('grid', { name: 'Workspace files' });
		const file = await within(content).findByRole('row', { name: /notebook.py/ });
		await user.click(file);
		const shortcut = new KeyboardEvent('keydown', {
			key: 'o',
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		file.dispatchEvent(shortcut);
		expect(shortcut.defaultPrevented).toBe(true);

		await user.pointer({ target: file, keys: '[MouseRight]' });

		const menu = await screen.findByRole('menu', { name: 'Context menu' });
		expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeEnabled();
	});

	it('clears sidebar directory selection after navigation', async () => {
		const user = setupUser();
		makeFetch({
			workspaceEntries: {
				'/': [{ path: '/data', name: 'data', kind: 'directory' }],
				'/data': [{ path: '/data/analysis.py', name: 'analysis.py', kind: 'file' }],
			},
		});
		await renderProject();
		await chooseNotebookAction(user, 'Browse files');

		const dialog = await screen.findByRole('dialog');
		const tree = await within(dialog).findByRole('treegrid', { name: 'Workspace tree' });
		const directory = await within(tree).findByText('data');
		await user.click(directory);

		await waitFor(() => expect(within(dialog).getByText('/data')).toBeInTheDocument());
		expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled();
		expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
		expect(within(dialog).queryByText('1 selected')).not.toBeInTheDocument();

		await user.click(directory);
		expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled();
		expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
	});

	it('"View static outputs" opens the sandbox-free snapshot page', async () => {
		const user = setupUser();
		const calls = makeFetch();
		await renderProject();

		await chooseNotebookAction(user, 'View static outputs');
		expect(await screen.findByText('snapshot page')).toBeInTheDocument();
		// A navigation, not compute: no session create fired.
		expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions'))).toBe(false);
	});

	it('deletes a notebook only after confirmation', async () => {
		const user = setupUser();
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

	it('hides "Jobs & schedules" when the deployment has jobs off', async () => {
		const user = setupUser();
		makeFetch({
			capabilities: {
				federation: { available: false, default_enabled: false },
				jobs: { available: false },
			},
		});
		await renderProject();

		await user.click(await screen.findByRole('button', { name: /Notebook actions for/ }));
		const menu = await screen.findByRole('menu');
		const labels = within(menu)
			.getAllByRole('menuitem')
			.map((item) => item.textContent);
		expect(labels).toContain('Version history');
		expect(labels).not.toContain('Jobs & schedules');
	});

	it('offers "Change base image" only when the deployment lists multiple images', async () => {
		const user = setupUser();
		makeFetch({
			capabilities: {
				federation: { available: false, default_enabled: false },
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
		const user = setupUser();
		makeFetch({
			capabilities: {
				federation: { available: false, default_enabled: false },
				sandbox_images: ['img-a'],
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		expect(await screen.findByText('Rename')).toBeInTheDocument();
		expect(screen.queryByText('Change base image')).not.toBeInTheDocument();
	});

	it('does not clutter the notebook list when there is only one compute profile', async () => {
		makeFetch({
			capabilities: {
				federation: { available: false, default_enabled: false },
				compute_profiles: [{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 }],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		expect(screen.queryByText('small')).not.toBeInTheDocument();
	});

	it('offers "Move to project…" only to managers', async () => {
		const user = setupUser();
		makeFetch({ role: 'editor' });
		await renderProject();
		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		const menu = await screen.findByRole('menu');
		expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
		expect(
			within(menu).queryByRole('menuitem', { name: 'Move to project…' }),
		).not.toBeInTheDocument();
	});

	it('duplicates a notebook from the overflow menu', async () => {
		const user = setupUser();
		const calls = makeFetch();
		const toastLoading = vi.spyOn(toast, 'loading');
		const toastSuccess = vi.spyOn(toast, 'success');
		await renderProject();

		await chooseNotebookAction(user, 'Duplicate');

		await waitFor(() =>
			expect(
				calls.some((c) => c.method === 'POST' && c.url.endsWith('/notebooks/nb-1/duplicate')),
			).toBe(true),
		);
		// A slow duplicate shows progress, and the success toast replaces it in place.
		expect(toastLoading).toHaveBeenCalledWith(expect.stringContaining('Duplicating'));
		await waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Duplicated'), {
				id: toastLoading.mock.results[0]?.value,
			}),
		);
	});
});
