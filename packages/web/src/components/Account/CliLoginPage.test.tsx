import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
import { CliLoginPage, parseCliLoginRequest } from './CliLoginPage';

const CALLBACK = 'http://127.0.0.1:49152/callback';
const STATE = 's'.repeat(32);
const CHALLENGE = 'c'.repeat(43);

function loginPath(callback = CALLBACK): string {
	const query = new URLSearchParams({
		callback_uri: callback,
		state: STATE,
		code_challenge: CHALLENGE,
	});
	return `/cli/login?${query}`;
}

function setup() {
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
			if (url === '/api/v1/me/cli-authorizations') {
				return jsonOk(
					{
						redirect_uri: `${CALLBACK}?code=mhub_cli_code&state=${STATE}`,
						expires_at: '2026-08-24T12:10:00.000Z',
					},
					{ status: 201 },
				);
			}
			throw new Error(`unexpected request: ${url}`);
		}),
	);
	const navigate = vi.fn();
	renderWithClient(
		<AuthProvider>
			<CliLoginPage navigate={navigate} />
		</AuthProvider>,
	);
	return { calls, navigate };
}

beforeEach(() => {
	installMatchMedia(false);
	window.history.replaceState({}, '', loginPath());
});

afterEach(() => {
	vi.unstubAllGlobals();
	window.history.replaceState({}, '', '/');
});

describe('CliLoginPage', () => {
	it('shows the signed-in account and a 30-day default', async () => {
		setup();

		expect(await screen.findByText(/dev@example.com/)).toBeInTheDocument();
		expect(screen.getByLabelText('Token lifetime (days)')).toHaveValue('30');
		expect(
			screen.getByText(/credential returns only to the local CLI callback/i),
		).toBeInTheDocument();
	});

	it('approves with the configurable lifetime and returns to the loopback callback', async () => {
		const user = userEvent.setup();
		const { calls, navigate } = setup();
		await screen.findByText(/dev@example.com/);

		await user.clear(screen.getByLabelText('Token lifetime (days)'));
		await user.type(screen.getByLabelText('Token lifetime (days)'), '45');
		await user.click(screen.getByRole('button', { name: 'Authorize CLI' }));

		expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?code=mhub_cli_code&state=${STATE}`);
		expect(calls).toContainEqual({
			url: '/api/v1/me/cli-authorizations',
			body: {
				callback_uri: CALLBACK,
				state: STATE,
				code_challenge: CHALLENGE,
				token_name: 'mohub CLI',
				expires_in_days: 45,
			},
		});
	});

	it('offers quick lifetime presets', async () => {
		const user = userEvent.setup();
		setup();
		await screen.findByText(/dev@example.com/);

		await user.click(screen.getByRole('button', { name: '90d' }));
		expect(screen.getByLabelText('Token lifetime (days)')).toHaveValue('90');
	});

	it('returns an access-denied callback when cancelled', async () => {
		const user = userEvent.setup();
		const { navigate } = setup();
		await screen.findByText(/dev@example.com/);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?error=access_denied&state=${STATE}`);
	});

	it.each([
		'https://evil.example/callback',
		'http://localhost:49152/callback',
		'http://127.0.0.1:49152/not-callback',
	])('rejects an unsafe callback: %s', (callback) => {
		expect(parseCliLoginRequest(loginPath(callback).slice('/cli/login'.length))).toBeNull();
	});

	it('renders a safe failure state for malformed requests', () => {
		window.history.replaceState({}, '', '/cli/login?state=missing-everything-else');
		setup();

		expect(screen.getByRole('heading', { name: 'Invalid CLI login request' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Authorize CLI' })).not.toBeInTheDocument();
	});
});
