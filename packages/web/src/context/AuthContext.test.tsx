import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { userKeys } from '@/api/queryKeys';
import type { User } from '@/types';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { AuthProvider, useAuth } from './AuthContext';

const ME: User = { id: 'usr-1', email: 'ada@example.com', logout_url: null };

type AuthValue = ReturnType<typeof useAuth>;

/** Every context value this probe has rendered with, oldest first. */
const seen: AuthValue[] = [];

function Probe({ label = 'a' }: { label?: string }) {
	const auth = useAuth();
	seen.push(auth);
	return (
		<div>
			<span data-testid="label">{label}</span>
			<span data-testid="user">{auth.user?.email ?? 'anonymous'}</span>
			<span data-testid="pending">{String(auth.isPending)}</span>
			<span data-testid="error">{auth.error?.message ?? 'no-error'}</span>
			<button type="button" onClick={auth.signIn}>
				Sign in
			</button>
			<button type="button" onClick={auth.signOut}>
				Sign out
			</button>
			<button type="button" onClick={auth.refetchUser}>
				Refetch
			</button>
		</div>
	);
}

function stubLocation(): void {
	vi.stubGlobal('location', { ...window.location, href: '' });
}

beforeEach(() => {
	seen.length = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('useAuth', () => {
	it('throws when rendered outside an AuthProvider', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => renderWithClient(<Probe />, { toaster: false })).toThrow(
			'useAuth must be used within an AuthProvider',
		);
	});
});

describe('AuthProvider', () => {
	it('reports no user while /api/v1/me is in flight, then the resolved user', async () => {
		let resolveMe: (response: Response) => void = () => {};
		const inFlight = new Promise<Response>((resolve) => {
			resolveMe = resolve;
		});
		const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) => inFlight);
		vi.stubGlobal('fetch', fetchMock);

		renderWithClient(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
			{ toaster: false },
		);

		expect(screen.getByTestId('pending')).toHaveTextContent('true');
		expect(screen.getByTestId('user')).toHaveTextContent('anonymous');
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/me');

		await act(async () => {
			resolveMe(jsonOk(ME));
		});

		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada@example.com'));
		expect(screen.getByTestId('pending')).toHaveTextContent('false');
		expect(screen.getByTestId('error')).toHaveTextContent('no-error');
	});

	it('exposes the error without a user and does not retry the failed request', async () => {
		// A client that WOULD retry, so the single call proves the query's own
		// `retry: false` (not the test client's default) is what stops it.
		const client = new QueryClient({
			defaultOptions: { queries: { retry: 3, retryDelay: 0 } },
		});
		const fetchMock = vi.fn(async () => jsonError('UNAUTHORIZED', 'not signed in', 401));
		vi.stubGlobal('fetch', fetchMock);

		renderWithClient(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
			{ client, toaster: false },
		);

		await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('not signed in'));
		expect(screen.getByTestId('user')).toHaveTextContent('anonymous');
		expect(screen.getByTestId('pending')).toHaveTextContent('false');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('signIn navigates to the server OIDC entry point', async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(ME)),
		);
		stubLocation();

		renderWithClient(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
			{ toaster: false },
		);

		await user.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(window.location.href).toBe('/api/auth/login');
	});

	it('signOut navigates to the IdP logout url when the user has one', async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk({ ...ME, logout_url: 'https://idp.example/logout' })),
		);
		stubLocation();

		renderWithClient(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
			{ toaster: false },
		);

		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada@example.com'));
		await user.click(screen.getByRole('button', { name: 'Sign out' }));
		expect(window.location.href).toBe('https://idp.example/logout');
	});

	it('signOut clears the cached user when there is no logout url', async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(ME)),
		);
		stubLocation();

		const { client } = renderWithClient(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
			{ toaster: false },
		);

		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada@example.com'));
		await user.click(screen.getByRole('button', { name: 'Sign out' }));

		expect(window.location.href).toBe('');
		expect(client.getQueryData(userKeys.me())).toBeNull();
		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('anonymous'));
	});

	it('refetchUser invalidates the me query and refetches it', async () => {
		const user = userEvent.setup();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockImplementationOnce(async () => jsonOk(ME))
			.mockImplementation(async () => jsonOk({ ...ME, email: 'grace@example.com' }));
		vi.stubGlobal('fetch', fetchMock);

		renderWithClient(
			<AuthProvider>
				<Probe />
			</AuthProvider>,
			{ toaster: false },
		);

		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada@example.com'));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole('button', { name: 'Refetch' }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('grace@example.com'));
	});

	it('keeps the context value referentially stable across an unrelated re-render', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(ME)),
		);

		const { rerender } = renderWithClient(
			<AuthProvider>
				<Probe label="a" />
			</AuthProvider>,
			{ toaster: false },
		);

		await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('ada@example.com'));
		const before = seen.at(-1);
		const rendersBefore = seen.length;

		rerender(
			<AuthProvider>
				<Probe label="b" />
			</AuthProvider>,
		);

		expect(screen.getByTestId('label')).toHaveTextContent('b');
		expect(seen.length).toBeGreaterThan(rendersBefore);
		expect(seen.at(-1)).toBe(before);
	});
});
