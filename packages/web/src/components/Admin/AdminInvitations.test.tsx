import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { AdminInvitations } from './AdminInvitations';

const INVITATION = {
	email: 'guest@outside.com',
	created_by: 'admin',
	created_at: '2026-10-16T00:00:00Z',
};

interface SetupOptions {
	enabled?: boolean;
	rejectCreate?: boolean;
	rejectDelete?: boolean;
	items?: (typeof INVITATION)[];
	createGate?: Promise<void>;
}

function setup(options: SetupOptions = {}) {
	let items = options.items ?? [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/admin/invitations') {
				if (init?.method === 'POST') {
					await options.createGate;
					if (options.rejectCreate)
						return jsonError('FORBIDDEN', 'External invitations are disabled', 403);
					const { email } = JSON.parse(String(init.body)) as { email: string };
					const invitation = { email, created_by: 'admin', created_at: '2026-10-16T00:00:00Z' };
					items = [invitation];
					return jsonOk(invitation);
				}
				return jsonOk({ enabled: options.enabled ?? true, items });
			}
			if (url === '/api/v1/admin/invitations/guest%40outside.com' && init?.method === 'DELETE') {
				if (options.rejectDelete)
					return jsonError('INTERNAL_ERROR', 'Could not remove invitation', 500);
				items = [];
				return jsonOk({ revoked: true });
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	renderWithClient(<AdminInvitations />);
	return userEvent.setup();
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('hides invitation controls when disabled', async () => {
	setup({ enabled: false });
	await waitFor(() => expect(fetch).toHaveBeenCalled());
	expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument();
});

it('adds an invitation, shows it, and confirms removal', async () => {
	const user = setup();
	await user.click(await screen.findByRole('button', { name: 'Invite user' }));
	await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'guest@outside.com');
	await user.click(screen.getByRole('button', { name: 'Add invitation' }));
	expect(await screen.findByText('guest@outside.com')).toBeInTheDocument();
	await user.click(screen.getByRole('button', { name: 'Remove invitation for guest@outside.com' }));
	await user.click(screen.getByRole('button', { name: 'Remove invitation' }));
	await waitFor(() => expect(screen.queryByText('guest@outside.com')).not.toBeInTheDocument());
});

it('preserves failed creation input and permits a successful retry', async () => {
	const options = { rejectCreate: true };
	const user = setup(options);
	await user.click(await screen.findByRole('button', { name: 'Invite user' }));
	await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'guest@outside.com');
	await user.click(screen.getByRole('button', { name: 'Add invitation' }));
	await waitFor(() => expect(screen.getByRole('button', { name: 'Add invitation' })).toBeEnabled());
	expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('guest@outside.com');
	expect(await screen.findByText('External invitations are disabled')).toBeInTheDocument();
	options.rejectCreate = false;
	await user.click(screen.getByRole('button', { name: 'Add invitation' }));
	expect(await screen.findByText('guest@outside.com')).toBeInTheDocument();
});

it('keeps a failed removal visible and permits a successful retry', async () => {
	const options = { items: [INVITATION], rejectDelete: true };
	const user = setup(options);
	await user.click(
		await screen.findByRole('button', { name: 'Remove invitation for guest@outside.com' }),
	);
	await user.click(screen.getByRole('button', { name: 'Remove invitation' }));
	expect(await screen.findByText('Could not remove invitation')).toBeInTheDocument();
	expect(screen.getByText('guest@outside.com')).toBeInTheDocument();
	expect(screen.getByRole('dialog', { name: 'Remove invitation' })).toBeInTheDocument();
	options.rejectDelete = false;
	await user.click(screen.getByRole('button', { name: 'Remove invitation' }));
	await waitFor(() => expect(screen.queryByText('guest@outside.com')).not.toBeInTheDocument());
});

it('does not delete when removal is cancelled', async () => {
	const user = setup({ items: [INVITATION] });
	await user.click(
		await screen.findByRole('button', { name: 'Remove invitation for guest@outside.com' }),
	);
	await user.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(screen.getByText('guest@outside.com')).toBeInTheDocument();
	expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});

it('allows removal of saved invitations while creation is disabled', async () => {
	const user = setup({ enabled: false, items: [INVITATION] });
	await screen.findByText('guest@outside.com');
	expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument();
	await user.click(screen.getByRole('button', { name: 'Remove invitation for guest@outside.com' }));
	await user.click(screen.getByRole('button', { name: 'Remove invitation' }));
	await waitFor(() =>
		expect(screen.queryByRole('region', { name: 'External invitations' })).not.toBeInTheDocument(),
	);
});

it('does not submit a blank address even through form submission', async () => {
	const user = setup();
	await user.click(await screen.findByRole('button', { name: 'Invite user' }));
	const dialog = screen.getByRole('dialog', { name: 'Invite user' });
	await user.type(within(dialog).getByRole('textbox', { name: 'Email address' }), '   ');
	expect(within(dialog).getByRole('button', { name: 'Add invitation' })).toBeDisabled();
	await act(async () => {
		fireEvent.submit(dialog.querySelector('form')!);
	});
	expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not submit twice or close while a creation request is pending', async () => {
	const gate = deferred<void>();
	const user = setup({ createGate: gate.promise });
	await user.click(await screen.findByRole('button', { name: 'Invite user' }));
	await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'guest@outside.com');
	await user.click(screen.getByRole('button', { name: 'Add invitation' }));
	try {
		const dialog = screen.getByRole('dialog', { name: 'Invite user' });
		expect(await within(dialog).findByRole('button', { name: 'Adding…' })).toBeDisabled();
		await act(async () => {
			fireEvent.submit(dialog.querySelector('form')!);
		});
		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(screen.getByRole('dialog', { name: 'Invite user' })).toBeInTheDocument();
		expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
			1,
		);
	} finally {
		gate.resolve();
	}
	expect(await screen.findByText('guest@outside.com')).toBeInTheDocument();
});

it('shows a failure when the invitation directory cannot load', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonError('INTERNAL_ERROR', 'Invitation directory unavailable', 500)),
	);
	renderWithClient(<AdminInvitations />, { errorBoundary: true });
	expect(await screen.findByText('Request failed')).toBeInTheDocument();
	expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument();
});
