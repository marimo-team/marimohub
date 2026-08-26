import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import { CliDeviceLoginPage } from './CliDeviceLoginPage';

const USER_CODE = 'WDJB-MJHT';

function setup(options: { approvalFails?: boolean; approvalThrows?: boolean } = {}) {
	const calls: { url: string; body?: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url, body });
			if (url === '/api/v1/me') {
				return jsonOk({ id: 'user-one', email: 'dev@example.com', logout_url: null });
			}
			if (url === '/api/v1/me/cli-device-authorizations') {
				if (options.approvalThrows) throw new TypeError('network unavailable');
				if (options.approvalFails) {
					return jsonError('BAD_REQUEST', 'CLI authorization code is invalid or expired', 400);
				}
				return jsonOk({ expires_at: '2026-08-25T12:10:00.000Z' });
			}
			throw new Error(`unexpected request: ${url}`);
		}),
	);
	const navigate = vi.fn();
	renderWithClient(
		<AuthProvider>
			<CliDeviceLoginPage navigate={navigate} />
		</AuthProvider>,
	);
	return { calls, navigate };
}

beforeEach(() => {
	installMatchMedia(false);
	window.history.replaceState({}, '', `/cli/device?user_code=${USER_CODE}`);
});

afterEach(() => {
	vi.unstubAllGlobals();
	window.history.replaceState({}, '', '/');
});

describe('CliDeviceLoginPage', () => {
	it('shows the signed-in account, device code, and phishing warning', async () => {
		setup();

		expect(await screen.findByText(/dev@example.com/)).toBeInTheDocument();
		expect(screen.getByLabelText('Device code')).toHaveValue(USER_CODE);
		expect(screen.getByText(/same code is currently displayed/i)).toBeInTheDocument();
		expect(screen.getByText(/code sent by another person/i)).toBeInTheDocument();
	});

	it('approves the normalized code and shows a terminal handoff', async () => {
		const user = userEvent.setup();
		const { calls } = setup();
		await screen.findByText(/dev@example.com/);

		await user.clear(screen.getByLabelText('Device code'));
		await user.type(screen.getByLabelText('Device code'), 'wdjb mjht');
		await user.click(screen.getByRole('button', { name: '90d' }));
		await user.click(screen.getByRole('button', { name: 'Authorize CLI' }));

		expect(
			await screen.findByRole('heading', { name: 'CLI authorization approved' }),
		).toBeVisible();
		expect(screen.getByText(/WDJB-MJHT/)).toBeInTheDocument();
		expect(calls).toContainEqual({
			url: '/api/v1/me/cli-device-authorizations',
			body: {
				user_code: USER_CODE,
				token_name: 'mohub CLI',
				expires_in_days: 90,
			},
		});
	});

	it('rejects invalid code characters without calling the API', async () => {
		const user = userEvent.setup();
		const { calls } = setup();
		await screen.findByText(/dev@example.com/);

		await user.clear(screen.getByLabelText('Device code'));
		await user.type(screen.getByLabelText('Device code'), 'AAAA-AAAA');
		await user.click(screen.getByRole('button', { name: 'Authorize CLI' }));

		expect(await screen.findByText(/8-letter code shown by the mohub CLI/i)).toBeVisible();
		expect(calls.filter((call) => call.url.includes('cli-device'))).toEqual([]);
	});

	it.each(['0', '3651', '1.5', 'abc', ''])('rejects invalid token lifetime %j', async (value) => {
		const user = userEvent.setup();
		const { calls } = setup();
		await screen.findByText(/dev@example.com/);

		await user.clear(screen.getByLabelText('Token lifetime (days)'));
		if (value) await user.type(screen.getByLabelText('Token lifetime (days)'), value);
		await user.click(screen.getByRole('button', { name: 'Authorize CLI' }));

		expect(await screen.findByText(/between 1 and 3650 days/i)).toBeVisible();
		expect(calls.filter((call) => call.url.includes('cli-device'))).toEqual([]);
	});

	it('keeps the approval form open when the code is invalid or expired', async () => {
		const user = userEvent.setup();
		setup({ approvalFails: true });
		await screen.findByText(/dev@example.com/);

		await user.click(screen.getByRole('button', { name: 'Authorize CLI' }));

		expect(await screen.findByText(/invalid or expired/i)).toBeVisible();
		expect(screen.getByRole('button', { name: 'Authorize CLI' })).toBeEnabled();
	});

	it('keeps the approval form open after a network failure', async () => {
		const user = userEvent.setup();
		setup({ approvalThrows: true });
		await screen.findByText(/dev@example.com/);

		await user.click(screen.getByRole('button', { name: 'Authorize CLI' }));

		expect(await screen.findByText(/network unavailable/i)).toBeVisible();
		expect(screen.getByRole('button', { name: 'Authorize CLI' })).toBeEnabled();
	});

	it('returns home without approving when cancelled', async () => {
		const user = userEvent.setup();
		const { navigate, calls } = setup();
		await screen.findByText(/dev@example.com/);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(navigate).toHaveBeenCalledWith('/');
		expect(calls.filter((call) => call.url.includes('cli-device'))).toEqual([]);
	});

	it('includes the deployment prefix in the hard-navigation cancel URL', async () => {
		const base = document.createElement('base');
		base.href = '/marimohub/';
		document.head.append(base);
		try {
			const user = userEvent.setup();
			const { navigate } = setup();
			await screen.findByText(/dev@example.com/);

			await user.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(navigate).toHaveBeenCalledWith('/marimohub/');
		} finally {
			base.remove();
		}
	});
});
