import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import { OAuthConsentPage } from './OAuthConsentPage';

const ID = '01HXY0S6GWMBASVAG3PZ7Y2K5T';
const CALLBACK = 'cursor://oauth/callback';

function setup(options: { approveError?: boolean } = {}) {
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
			if (url === `/api/v1/me/oauth-authorizations/${ID}`) {
				return jsonOk({
					client_name: 'Cursor',
					client_uri: 'https://cursor.com',
					redirect_uri: CALLBACK,
					scopes: [],
					expires_at: '2026-09-03T13:10:00.000Z',
				});
			}
			if (url === `/api/v1/me/oauth-authorizations/${ID}/approve`) {
				if (options.approveError) return jsonError('INVALID_REQUEST', 'Authorization expired', 400);
				return jsonOk({ redirect_uri: `${CALLBACK}?code=approved` });
			}
			if (url === `/api/v1/me/oauth-authorizations/${ID}/deny`) {
				return jsonOk({ redirect_uri: `${CALLBACK}?error=access_denied` });
			}
			if (url.startsWith('/api/v1/projects')) {
				return jsonOk({ items: [], next_cursor: null });
			}
			throw new Error(`unexpected request: ${url}`);
		}),
	);
	const navigate = vi.fn();
	renderWithClient(
		<AuthProvider>
			<OAuthConsentPage navigate={navigate} />
		</AuthProvider>,
	);
	return { calls, navigate };
}

beforeEach(() => {
	installMatchMedia(false);
	window.history.replaceState({}, '', `/oauth/consent?id=${ID}`);
});

afterEach(() => {
	vi.unstubAllGlobals();
	window.history.replaceState({}, '', '/');
});

describe('OAuthConsentPage', () => {
	it('shows the client, complete redirect URI, and edit grant by default', async () => {
		setup();
		expect(await screen.findByText(/authorize Cursor/i)).toBeInTheDocument();
		expect(screen.getByText(CALLBACK)).toBeInTheDocument();
		expect(screen.getByRole('radio', { name: /^Edit notebooks/ })).toBeChecked();
		expect(screen.getByLabelText('Token lifetime (days)')).toHaveValue('7');
	});

	it('approves with the selected grant and returns to the client', async () => {
		const user = userEvent.setup();
		const { calls, navigate } = setup();
		await screen.findByText(/authorize Cursor/i);
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		await user.click(screen.getByRole('button', { name: 'Approve' }));

		expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?code=approved`);
		expect(calls).toContainEqual({
			url: `/api/v1/me/oauth-authorizations/${ID}/approve`,
			body: {
				grant: { actions: ['project.read', 'integration.read'], projects: '*' },
				expires_in_days: 7,
			},
		});
	});

	it('denies and returns to the client', async () => {
		const user = userEvent.setup();
		const { navigate } = setup();
		await screen.findByText(/authorize Cursor/i);
		await user.click(screen.getByRole('button', { name: 'Deny' }));
		expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?error=access_denied`);
	});

	it.each(['0', '91', '1.5', 'not-a-number'])(
		'does not submit an invalid token lifetime: %s',
		async (lifetime) => {
			const user = userEvent.setup();
			const { calls, navigate } = setup();
			await screen.findByText(/authorize Cursor/i);
			const input = screen.getByLabelText('Token lifetime (days)');
			await user.clear(input);
			await user.type(input, lifetime);
			await user.click(screen.getByRole('button', { name: 'Approve' }));

			expect(calls.some(({ url }) => url.endsWith('/approve'))).toBe(false);
			expect(navigate).not.toHaveBeenCalled();
		},
	);

	it('does not navigate when approval fails', async () => {
		const user = userEvent.setup();
		const { navigate } = setup({ approveError: true });
		await screen.findByText(/authorize Cursor/i);
		await user.click(screen.getByRole('button', { name: 'Approve' }));

		expect(navigate).not.toHaveBeenCalled();
	});

	it('shows an invalid request state when the authorization id is missing', async () => {
		window.history.replaceState({}, '', '/oauth/consent');
		const { calls } = setup();

		expect(await screen.findByRole('alert')).toHaveTextContent(
			'This authorization request is invalid or expired.',
		);
		expect(calls.some(({ url }) => url.includes('/oauth-authorizations/'))).toBe(false);
	});
});
