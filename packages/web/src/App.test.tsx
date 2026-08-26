import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import App from './App';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState({}, '', '/');
	localStorage.clear();
});

describe('App routes', () => {
	it.each(['/admin/audit-logs', '/admin/users', '/admin/settings', '/admin/debug'])(
		'redirects a non-super-admin away from %s',
		async (path) => {
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
					if (url === '/api/v1/version') return jsonOk({ version: 'test' });
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			window.history.replaceState({}, '', path);

			renderWithClient(<App />, { toaster: false });

			expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
			expect(window.location.pathname).toBe('/');
			expect(requests.some((url) => url.startsWith('/api/v1/events?'))).toBe(false);
			expect(requests.some((url) => url.startsWith('/api/v1/admin/'))).toBe(false);
		},
	);

	it('redirects /admin to /admin/users for a super admin', async () => {
		installMatchMedia(false);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/me') {
					return jsonOk({
						id: 'user-one',
						email: 'admin@example.com',
						logout_url: null,
						is_super_admin: true,
					});
				}
				if (url === '/api/v1/admin/users') return jsonOk({ items: [] });
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', '/admin');

		renderWithClient(<App />, { toaster: false });

		expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
		expect(window.location.pathname).toBe('/admin/users');
	});

	it('shows the error boundary when an admin endpoint fails', async () => {
		installMatchMedia(false);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/me') {
					return jsonOk({
						id: 'user-one',
						email: 'admin@example.com',
						logout_url: null,
						is_super_admin: true,
					});
				}
				if (url === '/api/v1/admin/users') {
					return jsonError('INTERNAL_ERROR', 'Internal server error', 500);
				}
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', '/admin/users');

		renderWithClient(<App />, { toaster: false });

		expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
		expect(screen.getByText('Internal server error')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});

	it('shows the users page with the admin nav to a super admin', async () => {
		installMatchMedia(false);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/me') {
					return jsonOk({
						id: 'user-one',
						email: 'admin@example.com',
						logout_url: null,
						is_super_admin: true,
					});
				}
				if (url === '/api/v1/admin/users') {
					return jsonOk({
						items: [
							{
								id: 'user-ada',
								email: 'ada@example.com',
								name: 'Ada Lovelace',
								updated_at: '2026-08-01T00:00:00.000Z',
								is_super_admin: true,
							},
						],
					});
				}
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', '/admin/users');

		renderWithClient(<App />, { toaster: false });

		expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
		expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Debug' })).toHaveAttribute('href', '/admin/debug');
		expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
		expect(window.location.pathname).toBe('/admin/users');
	});

	it('shows the lazy debug page to a super admin', async () => {
		installMatchMedia(false);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/me') {
					return jsonOk({
						id: 'user-one',
						email: 'admin@example.com',
						logout_url: null,
						is_super_admin: true,
					});
				}
				if (url === '/api/v1/capabilities') {
					return jsonOk({
						sandbox_images: [],
						sandbox_startup_timeout_seconds: 120,
						compute_profiles: [],
					});
				}
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', '/admin/debug');

		renderWithClient(<App />, { toaster: false });

		expect(
			await screen.findByRole('heading', { name: 'Sandbox startup time' }),
		).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Debug' })).toHaveAttribute('aria-current', 'page');
		expect(window.location.pathname).toBe('/admin/debug');
	});
});
