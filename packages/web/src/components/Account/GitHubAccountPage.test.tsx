import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { installMatchMedia, jsonOk, renderWithClient, setupUser } from '@/test/render';
import { GitHubAccountPage } from './GitHubAccountPage';
function setup(enabled: boolean, connected: boolean, route = '/account/github') {
	installMatchMedia(false);
	const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
		init?.method === 'DELETE'
			? jsonOk({ remote_revocation_confirmed: true })
			: jsonOk({ enabled, account: { login: 'alice', account_id: '123', connected } }),
	);
	vi.stubGlobal('fetch', fetcher);
	renderWithClient(
		<MemoryRouter initialEntries={[route]}>
			<GitHubAccountPage />
		</MemoryRouter>,
	);
	return fetcher;
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it('keeps disconnect available when personal mode is disabled', async () => {
	const fetcher = setup(false, true);
	const button = await screen.findByRole('button', { name: 'Disconnect GitHub' });
	expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
	expect(screen.getByText(/shared GitHub App/)).toBeInTheDocument();
	await setupUser().click(button);
	expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true);
});
it('shows reconnect and callback failure instructions without exposing tokens', async () => {
	setup(true, false, '/account/github?connection=failed');
	expect(await screen.findByText(/needs to be replaced/)).toBeInTheDocument();
	expect(screen.getByText(/could not be completed/)).toBeInTheDocument();
	expect(screen.getByText(/Verification establishes commit provenance/)).toBeInTheDocument();
});

it.each(['POST', 'DELETE'] as const)(
	'keeps account state and shows a failed %s action',
	async (method) => {
		installMatchMedia(false);
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === method
				? new Response(
						JSON.stringify({
							success: false,
							error: { code: 'UNAVAILABLE', message: 'GitHub is unavailable; try again' },
						}),
						{ status: 503, headers: { 'Content-Type': 'application/json' } },
					)
				: jsonOk({
						enabled: true,
						account:
							method === 'POST' ? null : { login: 'alice', account_id: '123', connected: true },
					}),
		);
		vi.stubGlobal('fetch', fetcher);
		renderWithClient(
			<MemoryRouter>
				<GitHubAccountPage />
			</MemoryRouter>,
		);
		const name = method === 'POST' ? 'Connect GitHub' : 'Disconnect GitHub';
		await setupUser().click(await screen.findByRole('button', { name }));
		expect(await screen.findByRole('alert')).toHaveTextContent('GitHub is unavailable; try again');
		expect(screen.getByRole('button', { name })).toBeEnabled();
		expect(fetcher.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1);
		if (method === 'DELETE')
			expect(screen.getByText('Connected account: @alice')).toBeInTheDocument();
	},
);

it('warns when local disconnect succeeds but remote revocation is uncertain', async () => {
	const warning = vi.spyOn(toast, 'warning').mockReturnValue('warning');
	const success = vi.spyOn(toast, 'success');
	const fetcher = setup(true, true);
	const fetch = fetcher.getMockImplementation()!;
	fetcher.mockImplementation((input, init) =>
		init?.method === 'DELETE'
			? Promise.resolve(jsonOk({ remote_revocation_confirmed: false }))
			: fetch(input, init),
	);
	await setupUser().click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
	await vi.waitFor(() =>
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining('Revoke the App authorization in GitHub'),
		),
	);
	expect(success).not.toHaveBeenCalled();
});
