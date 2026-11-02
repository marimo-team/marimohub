import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import { userKeys, systemKeys } from '@/api/queryKeys';
import { deferred } from '@/test/deferred';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { hit, response, setup } from '@/test/search';
import { SearchSnippet } from './SearchResult';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	onlineManager.setOnline(true);
});

describe('Search recovery and input boundaries', () => {
	it('treats an empty type parameter as all types without duplicate choices', async () => {
		const { user, searches } = setup({ route: '/search?q=revenue&kind=' });
		await screen.findByRole('link', { name: /Revenue model/ });
		expect(searches[0]?.searchParams.has('kinds')).toBe(false);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: /Type$/ }));
		expect(screen.getAllByRole('option', { name: 'All types' })).toHaveLength(1);
		expect(screen.queryByRole('option', { name: 'Unavailable type' })).not.toBeInTheDocument();
	});

	it('waits for composition to finish before searching or moving focus', async () => {
		const { searches } = setup();
		await screen.findByRole('link', { name: /Revenue model/ });
		const input = screen.getByRole('searchbox');
		input.focus();
		vi.useFakeTimers();
		fireEvent.compositionStart(input);
		fireEvent.change(input, { target: { value: '売上' } });
		fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
		await act(() => vi.advanceTimersByTimeAsync(400));
		expect(input).toHaveFocus();
		expect(searches).toHaveLength(1);
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		fireEvent.compositionEnd(input, { data: '売上' });
		await act(() => vi.advanceTimersByTimeAsync(500));
		vi.useRealTimers();
		await waitFor(() => expect(searches).toHaveLength(2));
		expect(searches[1]?.searchParams.get('q')).toBe('売上');
	});

	it.each(['clear', 'unmount', 'compose'])('aborts pending requests on %s', async (action) => {
		const pending = deferred<Response>();
		let signal: AbortSignal | null | undefined;
		const { unmount } = setup({
			search: async (_url, value) => {
				signal = value;
				return pending.promise;
			},
		});
		await waitFor(() => expect(signal).toBeDefined());
		if (action === 'unmount') unmount();
		else if (action === 'clear')
			fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
		else fireEvent.compositionStart(screen.getByRole('searchbox'));
		expect(signal?.aborted).toBe(true);
		await act(async () => pending.resolve(response()));
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
	});

	it('hides old results during offline revalidation and resumes on reconnect', async () => {
		let calls = 0;
		const { client } = setup({
			search: async () =>
				response([{ ...hit, title: ++calls === 1 ? 'Before reconnect' : 'After reconnect' }]),
		});
		await screen.findByRole('link', { name: /Before reconnect/ });
		act(() => {
			onlineManager.setOnline(false);
			void client.invalidateQueries({ queryKey: ['workspace-search'] });
		});
		expect(await screen.findByText('Waiting for connection…')).toBeVisible();
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		expect(calls).toBe(1);
		act(() => onlineManager.setOnline(true));
		expect(await screen.findByRole('link', { name: /After reconnect/ })).toBeVisible();
	});

	it('does not reuse another account’s results for the same query', async () => {
		let switched = false;
		const pending = deferred<Response>();
		const { client } = setup({ search: async () => (switched ? pending.promise : response()) });
		await screen.findByRole('link', { name: /Revenue model/ });
		switched = true;
		act(() => {
			client.setQueryData(userKeys.me(), { id: 'other-user', app_only: false });
		});
		await waitFor(() => expect(screen.queryByRole('link')).not.toBeInTheDocument());
		await act(async () => pending.resolve(response([])));
		expect(await screen.findByText('No results found')).toBeVisible();
	});

	it('removes results and disables shortcuts when the account loses workspace access', async () => {
		const { client } = setup();
		await screen.findByRole('link', { name: /Revenue model/ });
		act(() => {
			client.setQueryData(userKeys.me(), { id: 'u', app_only: true });
		});
		expect(await screen.findByText('Search is not available for this account.')).toBeVisible();
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		expect(fireEvent.keyDown(document, { key: 'k', ctrlKey: true })).toBe(true);
	});

	it('fails closed on capability lookup failure, then recovers on retry', async () => {
		let attempts = 0;
		const { searches, user } = setup({
			capabilities: async () =>
				++attempts === 1
					? jsonError('SERVICE_UNAVAILABLE', 'private capability failure', 503)
					: jsonOk({ search: { available: true, kinds: ['code'], semantic: false } }),
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not load search.');
		expect(searches).toHaveLength(0);
		expect(fireEvent.keyDown(document, { key: 'k', ctrlKey: true })).toBe(true);
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByRole('link', { name: /Revenue model/ })).toBeVisible();
	});

	it('discards cached capability grants after a failed refresh', async () => {
		let failed = false;
		const { client } = setup({
			capabilities: async () =>
				failed
					? jsonError('FORBIDDEN', 'Forbidden', 403)
					: jsonOk({ search: { available: true, kinds: ['code'], semantic: false } }),
		});
		await screen.findByRole('link', { name: /Revenue model/ });
		failed = true;
		await act(async () => {
			await client.invalidateQueries({ queryKey: systemKeys.capabilities() });
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not load search.');
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		expect(fireEvent.keyDown(document, { key: 'k', ctrlKey: true })).toBe(true);
	});

	it.each([404, 403])('handles deleted or inaccessible projects (%s)', async (status) => {
		setup({
			route: '/projects/alpha/search?q=revenue',
			search: async () =>
				jsonError(status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', 'private metadata', status),
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('no longer have access');
		expect(screen.queryByRole('link')).not.toBeInTheDocument();
		expect(screen.queryByText('private metadata')).not.toBeInTheDocument();
	});

	it.each(['network', 'malformed JSON'])('recovers from %s responses', async (failure) => {
		let attempts = 0;
		const { user } = setup({
			search: async () => {
				if (++attempts > 1) return response();
				if (failure === 'network') throw new TypeError('Network down');
				return new Response('{invalid', { headers: { 'content-type': 'application/json' } });
			},
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('Search could not finish');
		await user.click(screen.getByRole('button', { name: 'Retry search' }));
		expect(await screen.findByRole('link', { name: /Revenue model/ })).toBeVisible();
	});

	it('can recover from an unavailable hybrid mode without losing scope or query', async () => {
		const { user, searches } = setup({
			route: '/projects/alpha/search?q=revenue&kind=code&mode=hybrid',
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('mode is unavailable');
		expect(searches).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Use keyword search' }));
		await screen.findByRole('link', { name: /Revenue model/ });
		expect(searches[0]?.searchParams.get('project_id')).toBe('alpha');
		expect(searches[0]?.searchParams.get('kinds')).toBe('code');
		expect(searches[0]?.searchParams.get('mode')).toBe('keyword');
	});

	it('retains reserved query characters and trims only surrounding whitespace', async () => {
		const query = '  revenue + costs & 売上/#?  ';
		const { searches } = setup({ route: `/search?${new URLSearchParams({ q: query })}` });
		await screen.findByRole('link', { name: /Revenue model/ });
		expect(screen.getByRole('searchbox')).toHaveValue(query);
		expect(searches[0]?.searchParams.get('q')).toBe(query.trim());
	});

	it('does not consume navigation keys without results or with modifiers', async () => {
		setup({ search: async () => response([]) });
		await screen.findByText('No results found');
		const input = screen.getByRole('searchbox');
		input.focus();
		expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true);
		expect(fireEvent.keyDown(input, { key: 'ArrowUp', ctrlKey: true })).toBe(true);
		expect(input).toHaveFocus();
	});

	it('stays on the last result and returns to the input from the first', async () => {
		const { user } = setup({
			search: async () => response([hit, { ...hit, id: 'two', title: 'Second result' }]),
		});
		await screen.findByRole('link', { name: /Second result/ });
		await user.click(screen.getByRole('searchbox'));
		await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
		expect(screen.getByRole('link', { name: /Second result/ })).toHaveFocus();
		await user.keyboard('{ArrowUp}{ArrowUp}');
		expect(screen.getByRole('searchbox')).toHaveFocus();
	});

	it('keeps multilingual text intact with UTF-16 highlight offsets', () => {
		renderWithClient(
			<p data-testid="snippet">
				<SearchSnippet
					snippet={{
						text: '💰売上 café',
						highlights: [
							{ start: 2, end: 4 },
							{ start: 4.5, end: 6 },
							{ start: 5, end: 9 },
							{ start: Number.NaN, end: Infinity },
						],
					}}
				/>
			</p>,
			{ toaster: false },
		);
		const snippet = screen.getByTestId('snippet');
		expect(snippet.textContent).toBe('💰売上 café');
		expect([...snippet.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
			'売上',
			'café',
		]);
	});
});
