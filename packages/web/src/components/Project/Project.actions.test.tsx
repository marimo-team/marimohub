import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { Session } from '@/types';
import {
	chooseNotebookAction,
	makeFetch,
	renderProject,
	runningSession,
} from './Project.testWorld';

describe('Project — Notebook Actions: configuration', () => {
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
			'View static outputs',
			'Version history',
			'Download notebook file',
			'Download outputs (HTML)',
			'Download workspace',
			'Delete',
		]);
	});

	it('"View static outputs" opens the sandbox-free snapshot page', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderProject();

		await chooseNotebookAction(user, 'View static outputs');
		expect(await screen.findByText('snapshot page')).toBeInTheDocument();
		// A navigation, not compute: no session create fired.
		expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions'))).toBe(false);
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
