import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { Session } from '@/types';
import {
	PID,
	chooseNotebookAction,
	installDownloadMocks,
	makeFetch,
	notebook,
	renderProject,
	runningSession,
	stoppableSession,
} from './Project.testWorld';

describe('Project — Notebook Actions: files and sessions', () => {
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

	it('downloads the outputs snapshot as HTML', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		const { createObjectURL } = installDownloadMocks();
		await renderProject();

		await chooseNotebookAction(user, 'Download outputs (HTML)');

		await waitFor(() =>
			expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/notebooks/nb-1/html'))).toBe(
				true,
			),
		);
		expect(createObjectURL).toHaveBeenCalledOnce();
	});

	it('downloads the notebook workspace archive', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		const { createObjectURL } = installDownloadMocks();
		const toastLoading = vi.spyOn(toast, 'loading');
		await renderProject();

		await chooseNotebookAction(user, 'Download workspace');

		await waitFor(() =>
			expect(
				calls.some((c) => c.method === 'GET' && c.url.endsWith('/notebooks/nb-1/workspace.zip')),
			).toBe(true),
		);
		expect(createObjectURL).toHaveBeenCalledOnce();
		expect(toastLoading).toHaveBeenCalledWith(expect.stringContaining('Preparing workspace'));
	});

	it('offers one unified sync settings action for a git-backed notebook', async () => {
		const user = userEvent.setup();
		makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
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

	it('keeps source settings read-only but operational controls available to editors', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'editor', notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		await chooseNotebookAction(user, 'Sync settings');
		const repo = await screen.findByLabelText('Repository');
		await waitFor(() => expect(repo).toHaveValue('acme/analytics'));
		expect(repo).toHaveAttribute('readonly');
		expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Rotate token' })).toBeInTheDocument();
	});

	it('offers git notebook creation only to managers', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'manager' });
		await renderProject();

		await user.click(screen.getByRole('button', { name: 'More create options' }));
		expect(await screen.findByText('Sync from git repo')).toBeInTheDocument();
	});

	it('does not offer git notebook creation to editors', async () => {
		makeFetch({ role: 'editor' });
		await renderProject();

		expect(screen.queryByRole('button', { name: 'More create options' })).not.toBeInTheDocument();
		expect(screen.queryByText('Sync from git repo')).not.toBeInTheDocument();
	});

	it("a git row's source tile opens a popover with GitHub links", async () => {
		const user = userEvent.setup();
		makeFetch({ notebooks: [{ ...notebook(), source_type: 'git' }] });
		await renderProject();

		const trigger = screen.getByRole('button', { name: 'Synced from a git repository — details' });
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

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
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

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
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

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
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

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
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
		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		expect(screen.queryByRole('menuitem', { name: 'Shut down kernel' })).not.toBeInTheDocument();
	});
});
