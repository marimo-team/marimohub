import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMatchMedia, jsonError, jsonOk, renderWithClient } from '@/test/render';
import App from './App';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState({}, '', '/');
	localStorage.clear();
});

describe('App routes', () => {
	it.each([true, false])('selects the landing page from app_only=%s', async (appOnly) => {
		installMatchMedia(false);
		const requests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				requests.push(url);
				if (url === '/api/v1/me')
					return jsonOk({
						id: 'stakeholder',
						email: 'stakeholder@example.com',
						is_super_admin: false,
						logout_url: null,
						app_only: appOnly,
						groups: [],
						can_create_projects: !appOnly,
					});
				if (url.startsWith('/api/v1/apps') || url.split('?')[0] === '/api/v1/projects')
					return jsonOk({ items: [], next_cursor: null });
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		renderWithClient(<App />, { toaster: false });
		expect(
			await screen.findByRole('heading', { name: appOnly ? 'Apps' : 'Projects' }),
		).toBeVisible();
		expect(window.location.pathname).toBe(appOnly ? '/apps' : '/projects');
		if (appOnly)
			expect(requests.some((url) => url.split('?')[0] === '/api/v1/projects')).toBe(false);
		else expect(screen.getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '/apps');
	});

	it.each([
		'/admin/audit-logs',
		'/admin/users',
		'/admin/settings',
		'/admin/colors',
		'/admin/policy-analyzer',
		'/admin/debug',
	])('redirects a non-super-admin away from %s', async (path) => {
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
						groups: [],
					});
				}
				if (url.split('?')[0] === '/api/v1/projects')
					return jsonOk({ items: [], next_cursor: null });
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', path);

		renderWithClient(<App />, { toaster: false });

		expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
		expect(window.location.pathname).toBe('/projects');
		expect(requests.some((url) => url.startsWith('/api/v1/events?'))).toBe(false);
		expect(requests.some((url) => url.startsWith('/api/v1/admin/'))).toBe(false);
	});

	it('requires sign-in before rendering the Colors tab', async () => {
		installMatchMedia(false);
		const fetch = vi.fn(async () => jsonError('UNAUTHORIZED', 'Sign in required', 401));
		vi.stubGlobal('fetch', fetch);
		window.history.replaceState({}, '', '/admin/colors');
		renderWithClient(<App />, { toaster: false });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
		expect(screen.queryByRole('heading', { name: 'Colors' })).not.toBeInTheDocument();
		expect(screen.queryByRole('table')).not.toBeInTheDocument();
		expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
		expect(fetch.mock.calls).toHaveLength(1);
	});

	it('withholds Colors on account lookup failure and opens it after a successful retry', async () => {
		installMatchMedia(false);
		const user = userEvent.setup();
		let unavailable = true;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/v1/me') {
					return unavailable
						? jsonError('SERVICE_UNAVAILABLE', 'Account lookup unavailable', 503)
						: jsonOk({
								id: 'admin',
								email: 'admin@example.com',
								is_super_admin: true,
								logout_url: null,
								groups: [],
							});
				}
				if (url === '/api/v1/version') return jsonOk({ version: 'test' });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		window.history.replaceState({}, '', '/admin/colors');
		renderWithClient(<App />, { toaster: false });
		expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeVisible();
		expect(screen.queryByRole('heading', { name: 'Colors' })).not.toBeInTheDocument();
		expect(screen.queryByRole('table')).not.toBeInTheDocument();
		unavailable = false;
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByRole('heading', { name: 'Colors' })).toBeVisible();
		expect(screen.getByRole('table')).toBeVisible();
		expect(window.location.pathname).toBe('/admin/colors');
	});

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
						groups: [],
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
						groups: [],
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
						groups: [],
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
		expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
			'href',
			'/admin/settings',
		);
		expect(screen.getByRole('link', { name: 'Debug' })).toHaveAttribute('href', '/admin/debug');
		expect(screen.getByRole('link', { name: 'Colors' })).toHaveAttribute('href', '/admin/colors');
		expect(screen.getByRole('link', { name: 'Policy' })).toHaveAttribute(
			'href',
			'/admin/policy-analyzer',
		);
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
						groups: [],
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
