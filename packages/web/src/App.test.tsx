import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
import App from './App';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState({}, '', '/');
	localStorage.clear();
});

describe('App routes', () => {
	it('redirects a non-super-admin away from the audit log page', async () => {
		installMatchMedia(false);
		const requests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				requests.push(url);
				if (url === '/api/v1/me') {
					return jsonOk({
						id: 'user-one',
						email: 'user@example.com',
						logout_url: null,
						is_super_admin: false,
					});
				}
				if (url === '/api/v1/projects') return jsonOk({ items: [], next_cursor: null });
				if (url === '/api/v1/version') return jsonOk({ version: 'test', backends: {} });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', '/admin/audit-logs');

		renderWithClient(<App />, { toaster: false });

		expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
		expect(window.location.pathname).toBe('/');
		expect(requests.some((url) => url.startsWith('/api/v1/events?'))).toBe(false);
	});
});
