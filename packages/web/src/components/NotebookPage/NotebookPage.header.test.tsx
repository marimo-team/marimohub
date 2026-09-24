import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeFetch, renderPage, runningSession } from './NotebookPage.testWorld';

describe('Notebook header', () => {
	it('groups notebook actions with attribution and opens the rename dialog', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'editor' });
		renderPage();
		await screen.findByRole('button', { name: /Session Running/ });
		expect(screen.queryByText('Created by')).toBeNull();
		const menu = screen.getByRole('button', { name: 'Forecast — notebook menu' });
		menu.focus();
		await user.keyboard('{Enter}');
		expect(screen.getByText('Created by')).toBeVisible();
		expect(screen.getByRole('menuitem', { name: 'Jobs & schedules' })).toBeVisible();
		expect(screen.getByRole('menuitem', { name: 'Edit thumbnail…' })).toBeVisible();
		await user.click(screen.getByRole('menuitem', { name: 'Rename notebook…' }));
		expect(await screen.findByRole('dialog', { name: 'Rename Notebook' })).toBeVisible();
		await user.keyboard('{Escape}');
		await waitFor(() => expect(menu).toHaveFocus());
	});

	it('keeps sharing visible and confirms a shared stop from the session popover', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			session: runningSession({ mode: 'edit', editor_sandbox_sharing: 'shared' }),
		});
		renderPage();
		const session = await screen.findByRole('button', {
			name: 'Session Running · Shared — details',
		});
		expect(within(session).getByText('Shared')).toBeVisible();
		expect(screen.queryByText(/Project editors can view/)).toBeNull();
		expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
		await user.click(session);
		expect(screen.getByText('Project editors can view and edit this session.')).toBeVisible();
		await user.click(screen.getByRole('button', { name: 'Stop shared session…' }));
		const confirmation = await screen.findByRole('dialog', { name: 'Stop Shared Sandbox' });
		expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
		expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		await waitFor(() => expect(session).toHaveFocus());
	});

	it('does not expose session mutations without a server grant', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'editor', session: runningSession({ can: { attach: true, stop: false } }) });
		renderPage();
		await user.click(await screen.findByRole('button', { name: /Session Running/ }));
		expect(screen.queryByRole('button', { name: /Stop|Restart/ })).toBeNull();
	});

	it('keeps unsaved-work warnings visible and hides notebook mutations from viewers', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			session: runningSession({ mode: 'edit', ephemeral: true }),
		});
		renderPage();
		await screen.findByRole('button', { name: 'Session Running · Temporary — details' });
		expect(screen.getByText(/session is temporary and your changes won't be saved/)).toBeVisible();
		await user.click(screen.getByRole('button', { name: 'Forecast — notebook menu' }));
		expect(screen.queryByRole('menuitem', { name: /Rename|thumbnail/ })).toBeNull();
		expect(screen.getByRole('menuitem', { name: 'Jobs & schedules' })).toBeVisible();
	});

	it('keeps navigation out of Share and available under Open without extra tools', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'editor' });
		renderPage();
		await screen.findByRole('button', { name: /Session Running/ });
		await user.click(screen.getByRole('button', { name: 'Share notebook' }));
		expect(screen.getByRole('menuitem', { name: 'App links' })).toBeVisible();
		expect(screen.getByRole('menuitem', { name: 'Copy URL' })).toBeVisible();
		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'View static outputs' })).toBeNull();
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('button', { name: 'Open' }));
		expect(screen.getByRole('menuitem', { name: 'Run as app' })).toBeVisible();
		expect(screen.getByRole('menuitem', { name: 'View static outputs' })).toBeVisible();
	});
});
