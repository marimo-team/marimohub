import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { setupUser } from '@/test/render';
import type { Session } from '@/types';
import {
	chooseNotebookAction,
	makeFetch,
	renderProject,
	runningSession,
} from './Project.testWorld';

describe('Project — Notebook Actions: configuration', () => {
	it('lets editors change compute from the notebook overflow menu', async () => {
		const user = setupUser();
		const calls = makeFetch({
			role: 'editor',
			capabilities: {
				federation: { available: false, default_enabled: false },
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
		expect(
			within(within(dialog).getByRole('radiogroup', { name: 'Editing profile' })).getByRole(
				'radio',
				{ name: /Default \(small\)/ },
			),
		).toBeChecked();
		await user.click(
			within(within(dialog).getByRole('radiogroup', { name: 'Editing profile' })).getByRole(
				'radio',
				{ name: /large/ },
			),
		);
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
		const user = setupUser();
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
				federation: { available: false, default_enabled: false },
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
		await user.click(
			within(within(dialog).getByRole('radiogroup', { name: 'Editing profile' })).getByRole(
				'radio',
				{ name: /large/ },
			),
		);
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));
		await user.click(await screen.findByRole('button', { name: 'Restart edit session' }));

		await waitFor(() =>
			expect(
				calls.some(
					(call) => call.method === 'DELETE' && call.url.endsWith('/sessions/sess-edit?wait=true'),
				),
			).toBe(true),
		);
		expect(calls.some((call) => call.url.endsWith('/sessions/sess-app'))).toBe(false);
		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith('Restarted the session for "Forecast"');
		});
	});

	it('offers the app restart after an app-only compute change with both sessions live', async () => {
		const user = setupUser();
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
				federation: { available: false, default_enabled: false },
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
		await user.click(
			within(within(dialog).getByRole('radiogroup', { name: 'App profile' })).getByRole('radio', {
				name: /large/,
			}),
		);
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));
		await user.click(await screen.findByRole('button', { name: 'Restart app' }));

		const confirmation = await screen.findByRole('dialog');
		await user.click(within(confirmation).getByRole('button', { name: 'Restart' }));
		await waitFor(() => {
			const request = calls.find(
				(call) => call.method === 'POST' && call.url.endsWith('/sessions'),
			);
			expect(request?.body).toEqual({ mode: 'app', replace_app_session_id: 'sess-app' });
		});
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
	});

	it.each(['editor', 'viewer'] as const)(
		'lets an unassigned %s open an app through admission',
		async (role) => {
			const user = setupUser();
			makeFetch({
				role,
				capabilities: { viewer_session_modes: ['app'] },
				sessions: [
					{
						...runningSession(),
						mode: 'app',
						sandbox_url: undefined,
						can: { attach: false, stop: role === 'editor' },
					},
				],
			});
			await renderProject();
			await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
			expect(await screen.findByRole('menuitem', { name: 'Open app' })).toBeVisible();
		},
	);

	it('shows multiple app sandboxes and stops only the selected one', async () => {
		const user = setupUser();
		const calls = makeFetch({
			role: 'editor',
			sessions: ['sess-app-a', 'sess-app-b'].map(
				(session_id) =>
					({
						...runningSession(),
						session_id,
						mode: 'app',
						can: { attach: true, stop: true },
						app_pool: { state: 'ready', users: 3, max_users: 4 },
					}) as Session,
			),
		});
		await renderProject();
		const indicators = await screen.findAllByRole('button', { name: 'App running — details' });
		expect(indicators).toHaveLength(2);
		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		expect(screen.queryByRole('menuitem', { name: 'Stop app' })).toBeNull();
		await user.keyboard('{Escape}');
		await user.click(indicators[1]);
		expect(await screen.findByText('sess-app-b')).toBeInTheDocument();
		expect(screen.getByText('3 / 4')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Stop' }));
		const dialog = await screen.findByRole('dialog');
		expect(screen.queryByText('sess-app-b')).toBeNull();
		expect(within(dialog).getByText(/Stop this app sandbox/)).toBeInTheDocument();
		await user.click(within(dialog).getByRole('button', { name: 'Stop App' }));
		await waitFor(() =>
			expect(
				calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/sessions/sess-app-b')),
			).toBe(true),
		);
		expect(
			calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/sessions/sess-app-a')),
		).toBe(false);
	});

	it('requests explicit replacement of the selected app after impact confirmation', async () => {
		const user = setupUser();
		const calls = makeFetch({
			role: 'editor',
			sessions: ['sess-app-a', 'sess-app-b'].map(
				(session_id) =>
					({
						...runningSession(),
						session_id,
						mode: 'app',
						can: { attach: true, stop: true },
					}) as Session,
			),
		});
		await renderProject();
		const indicators = await screen.findAllByRole('button', { name: 'App running — details' });
		await user.click(indicators[1]);
		await user.click(screen.getByRole('button', { name: 'Restart' }));
		const dialog = await screen.findByRole('dialog');
		expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/sessions'))).toBe(
			false,
		);
		await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
		await waitFor(() => {
			const request = calls.find(
				(call) => call.method === 'POST' && call.url.endsWith('/sessions'),
			);
			expect(request?.body).toEqual({ mode: 'app', replace_app_session_id: 'sess-app-b' });
		});
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
	});

	it('keeps the app stale hint visible when only a temporary editor is running', async () => {
		const user = setupUser();
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
					source_version_id: 'ver-0',
					can: { attach: true, stop: true },
				} as Session,
			],
		});
		await renderProject();

		await user.click(await screen.findByRole('button', { name: 'App running — details' }));
		expect(
			await screen.findByText(/New browser sessions receive the latest version/),
		).toBeInTheDocument();
	});

	it('surfaces an edit-session restart failure from the compute toast', async () => {
		const user = setupUser();
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
				federation: { available: false, default_enabled: false },
				compute_profiles: [{ name: 'small' }, { name: 'large' }],
				compute_profile_override: 'editors',
			},
		});
		await renderProject();

		await chooseNotebookAction(user, 'Change compute…');
		const dialog = await screen.findByRole('dialog');
		await user.click(
			within(within(dialog).getByRole('radiogroup', { name: 'Editing profile' })).getByRole(
				'radio',
				{ name: /large/ },
			),
		);
		await user.click(within(dialog).getByRole('button', { name: 'Save' }));
		await user.click(await screen.findByRole('button', { name: 'Restart session' }));

		await waitFor(() => {
			expect(
				calls.some(
					(call) => call.method === 'DELETE' && call.url.endsWith('/sessions/sess-1?wait=true'),
				),
			).toBe(true);
			expect(toastError).toHaveBeenCalledWith('restart failed');
		});
	});

	it('hides the change-compute action when overrides are disabled', async () => {
		const user = setupUser();
		makeFetch({
			capabilities: {
				federation: { available: false, default_enabled: false },
				compute_profiles: [{ name: 'small' }, { name: 'large' }],
				compute_profile_override: 'none',
			},
		});
		await renderProject();

		await user.click(screen.getByRole('button', { name: /Notebook actions for/ }));
		expect(await screen.findByText('Rename')).toBeInTheDocument();
		expect(screen.queryByText('Change compute…')).not.toBeInTheDocument();
	});
});

describe('Project — create compute selection', () => {
	it.each([{ computeProfiles: [] }, { computeProfiles: [{ name: 'edit', cpu: 2 }] }])(
		'hides editing choices with app-only choices: %j',
		async ({ computeProfiles }) => {
			const user = setupUser();
			makeFetch({
				role: 'editor',
				capabilities: {
					federation: { available: false, default_enabled: false },
					compute_profiles: computeProfiles,
					app_compute_profiles: [
						{ name: 'app-small', cpu: 1 },
						{ name: 'app-large', cpu: 4 },
					],
					compute_profile_override: 'editors',
				},
			});
			await renderProject();
			await user.click(screen.getByRole('button', { name: 'New Notebook' }));
			const dialog = await screen.findByRole('dialog');
			expect(within(dialog).queryByRole('radiogroup', { name: 'Compute' })).not.toBeInTheDocument();
			await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
			await chooseNotebookAction(user, 'Change compute…');
			expect(await screen.findByRole('radiogroup', { name: 'App profile' })).toBeInTheDocument();
		},
	);
});
