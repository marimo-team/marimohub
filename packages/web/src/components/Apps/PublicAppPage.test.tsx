import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { PublicAppLinkPage } from './PublicAppPage';

function renderPublicRoute(initialEntry: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<ThemeProvider>
					<AuthProvider>
						<PublicAppLinkPage />
					</AuthProvider>
				</ThemeProvider>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe('PublicAppLinkPage', () => {
	it('renders the isolated public app iframe without sign-in when the link is public', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/api/v1/theme')) {
				return new Response(JSON.stringify({ success: true, data: {} }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('/api/v1/me')) {
				return new Response(
					JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Login' } }),
					{ status: 401, headers: { 'Content-Type': 'application/json' } },
				);
			}
			if (url.includes('/api/public/v1/apps/team/sales')) {
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							slug: 'team/sales',
							title: 'Public Sales App',
							heartbeat_interval_seconds: 30,
							startup_timeout_seconds: 60,
						},
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			if (url.includes('/api/public/v1/visits')) {
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							slug: 'team/sales',
							status: 'running',
							sandbox_url: 'https://sb-123.sandbox.example.net/',
							visit_token: 'v1.opaque-token',
							heartbeat_interval_seconds: 30,
							startup_timeout_seconds: 60,
						},
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response(
				JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }),
				{ status: 404, headers: { 'Content-Type': 'application/json' } },
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		renderPublicRoute('/app/team/sales');

		await waitFor(() => {
			expect(screen.getByTitle('Public Sales App').tagName).toBe('IFRAME');
		});
		expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
		expect(screen.queryByText('Back to apps')).toBeNull();
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/capabilities'))).toBe(
			false,
		);
	});

	it('falls back to SignIn on 404 so private and missing links keep the login flow', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/api/v1/theme')) {
				return new Response(JSON.stringify({ success: true, data: {} }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('/api/v1/me')) {
				return new Response(
					JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Login' } }),
					{ status: 401, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response(
				JSON.stringify({
					success: false,
					error: { code: 'NOT_FOUND', message: 'App link not found' },
				}),
				{ status: 404, headers: { 'Content-Type': 'application/json' } },
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		renderPublicRoute('/app/private-app');

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
		});
		expect(screen.queryByTitle('Public Sales App')).toBeNull();
	});
});
