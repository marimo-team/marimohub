import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ApiTokensDialog } from './ApiTokensDialog';
import type { ApiToken } from '@/types';
import { createTestQueryClient } from '@/test/render';

const TOKEN_ID = '01HXY0S6GWMBASVAG3PZ7Y2K5T';
const PLAINTEXT = `mhub_pat_${TOKEN_ID}_${'a'.repeat(32)}`;

const tokenMeta = (over: Partial<ApiToken> = {}): ApiToken => ({
	id: TOKEN_ID,
	name: 'ci-deploy',
	created_at: '2026-07-01T00:00:00.000Z',
	...over,
});

function ok(data: unknown, status = 200) {
	return new Response(JSON.stringify({ success: true, data }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Route the dialog's requests; the GET list serves `tokens` (mutable). */
function makeFetch(tokens: ApiToken[]) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		if (method !== 'GET') calls.push({ url, method, body });
		if (url.includes('/projects') && method === 'GET') {
			return ok({ items: [], next_cursor: null });
		}

		if (url.includes('/me/tokens')) {
			if (method === 'GET') return ok(tokens);
			if (method === 'POST') {
				return ok(
					{ ...tokenMeta({ name: (body as { name: string }).name }), token: PLAINTEXT },
					201,
				);
			}
			if (method === 'DELETE') return ok(undefined);
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

function setup(tokens: ApiToken[] = []) {
	const calls = makeFetch(tokens);
	const onClose = vi.fn();
	const client = createTestQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(<ApiTokensDialog isOpen onClose={onClose} />, { wrapper });
	return { calls, onClose };
}

beforeEach(() => {
	// jsdom has no matchMedia; Tooltip's mobile check needs it.
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => vi.unstubAllGlobals());

describe('ApiTokensDialog', () => {
	it('shows the empty state when the user has no tokens', async () => {
		setup([]);
		expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
	});

	it('lists existing tokens with metadata', async () => {
		setup([
			tokenMeta(),
			tokenMeta({
				id: '01HXY0S6GWMBASVAG3PZ7Y2K5V',
				name: 'laptop',
				last_used_at: '2026-07-20T00:00:00.000Z',
			}),
		]);

		const rows = await screen.findAllByTestId('token-row');
		expect(rows).toHaveLength(2);
		expect(screen.getByText('ci-deploy')).toBeInTheDocument();
		expect(screen.getByText('laptop')).toBeInTheDocument();
		expect(screen.getAllByText(/never used/)).toHaveLength(1);
	});

	it('shows remaining time for a future expiry and elapsed time for a past one', async () => {
		const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
		const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		setup([
			tokenMeta({ id: '01HXY0S6GWMBASVAG3PZ7Y2K5V', name: 'live', expires_at: future }),
			tokenMeta({ name: 'dead', expires_at: past }),
		]);

		await screen.findAllByTestId('token-row');
		// The fix: a future deadline shows a real remaining span, not "just now".
		expect(screen.getByText(/expires in \d+[dhm]/)).toBeInTheDocument();
		expect(screen.queryByText(/expires just now/)).not.toBeInTheDocument();
		expect(screen.getByText(/expired 3d ago/)).toBeInTheDocument();
	});

	it('creates a token and shows the plaintext once with a copy-now warning', async () => {
		const user = userEvent.setup();
		const { calls } = setup([]);

		await user.type(await screen.findByLabelText('Name'), 'ci-deploy');
		await user.type(screen.getByLabelText('Expires in days'), '90');
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.click(screen.getByRole('button', { name: /create token/i }));

		expect(await screen.findByLabelText('API token')).toHaveValue(PLAINTEXT);
		expect(screen.getByText(/shown once and cannot be retrieved later/i)).toBeInTheDocument();
		expect(calls).toEqual([
			{
				url: '/api/v1/me/tokens/scoped',
				method: 'POST',
				body: {
					name: 'ci-deploy',
					expires_in_days: 90,
					grant: { actions: ['project.read', 'integration.read'], projects: '*' },
				},
			},
		]);
	});

	it('rejects a blank name without calling the API', async () => {
		const user = userEvent.setup();
		const { calls } = setup([]);

		await screen.findByText('No tokens yet.');
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.click(screen.getByRole('button', { name: /create token/i }));

		expect(await screen.findByText(/name the token/i)).toBeInTheDocument();
		expect(calls).toEqual([]);
	});

	it('rejects a non-numeric expiry without calling the API', async () => {
		const user = userEvent.setup();
		const { calls } = setup([]);

		await user.type(await screen.findByLabelText('Name'), 'ci');
		await user.type(screen.getByLabelText('Expires in days'), 'soon');
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.click(screen.getByRole('button', { name: /create token/i }));

		expect(await screen.findByText(/whole number of days/i)).toBeInTheDocument();
		expect(calls).toEqual([]);
	});

	it('surfaces a server error when creation fails', async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (String(input).includes('/projects') && method === 'GET') {
					return ok({ items: [], next_cursor: null });
				}
				if (String(input).includes('/me/tokens') && method === 'GET') return ok([]);
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'RESOURCE_EXHAUSTED', message: 'Token limit reached' },
					}),
					{ status: 429, headers: { 'content-type': 'application/json' } },
				);
			}),
		);
		const client = createTestQueryClient();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
				<Toaster />
			</QueryClientProvider>
		);
		render(<ApiTokensDialog isOpen onClose={vi.fn()} />, { wrapper });

		await user.type(await screen.findByLabelText('Name'), 'ci');
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.click(screen.getByRole('button', { name: /create token/i }));

		expect(await screen.findByText('Token limit reached')).toBeInTheDocument();
		// The one-time-plaintext panel must NOT appear on a failed create.
		expect(screen.queryByLabelText('API token')).not.toBeInTheDocument();
	});

	it('revokes a token after confirmation', async () => {
		const user = userEvent.setup();
		const { calls } = setup([tokenMeta()]);

		await user.click(await screen.findByRole('button', { name: 'Revoke ci-deploy' }));
		await user.click(await screen.findByRole('button', { name: 'Revoke' }));

		await waitFor(() =>
			expect(calls).toEqual([
				{ url: `/api/v1/me/tokens/${TOKEN_ID}`, method: 'DELETE', body: undefined },
			]),
		);
	});
});
