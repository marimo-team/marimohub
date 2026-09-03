import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/context/AuthContext';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
import { OAuthConsentPage } from './OAuthConsentPage';

const ID = '01HXY0S6GWMBASVAG3PZ7Y2K5T';
const CALLBACK = 'cursor://oauth/callback';

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
	it('shows the client, redirect host, and edit grant by default', async () => {
		setup();
		expect(await screen.findByText(/authorize Cursor/i)).toBeInTheDocument();
		expect(screen.getByText('oauth')).toBeInTheDocument();
		expect(screen.getByRole('radio', { name: /^Edit notebooks/ })).toBeChecked();
		expect(screen.getByLabelText('Token lifetime (days)')).toHaveValue('30');
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
				expires_in_days: 30,
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
});
