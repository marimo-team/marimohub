import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { jsonError, renderWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { hit, response, setup, selectSearchFilter } from '@/test/search';
import { SearchSnippet } from './SearchResult';

afterEach(() => vi.unstubAllGlobals());

describe('Search page', () => {
	it('focuses on the global shortcut, without stealing focus on a plain visit', async () => {
		setup();
		const input = await screen.findByRole('searchbox');
		expect(input).not.toHaveFocus();
		fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
		await waitFor(() => expect(input).toHaveFocus());
	});
	it('renders safe snippets and opens results using the keyboard', async () => {
		const { user } = setup();
		const link = await screen.findByRole('link', { name: /Revenue model/ });
		expect(link.querySelector('mark')).toHaveTextContent('revenue');
		const input = screen.getByRole('searchbox', { name: 'Search content' });
		await user.click(input);
		await user.keyboard('{ArrowDown}');
		expect(link).toHaveFocus();
		await user.keyboard('{ArrowUp}');
		expect(input).toHaveFocus();
		await user.keyboard('{ArrowDown}{Escape}');
		expect(input).toHaveFocus();
		await user.keyboard('{ArrowDown}{Enter}');
		expect(await screen.findByText('Opened notebook')).toBeVisible();
	});
	it('keeps scope and type in the URL, restores history, and sends project-scoped requests', async () => {
		const { user, searches } = setup();
		await screen.findByRole('link', { name: /Revenue model/ });
		await selectSearchFilter(user, 'Scope', 'Alpha');
		await waitFor(() => expect(searches.at(-1)?.searchParams.get('project_id')).toBe('alpha'));
		await selectSearchFilter(user, 'Type', 'Code');
		await waitFor(() => expect(searches.at(-1)?.searchParams.get('kinds')).toBe('code'));
		expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(
			'/projects/alpha/search?q=revenue&kind=code',
		);
		await user.click(screen.getByRole('button', { name: 'Back' }));
		expect(screen.getByRole('button', { name: /Type$/ })).toHaveTextContent('All types');
		await user.click(screen.getByRole('button', { name: 'Back' }));
		expect(screen.getByRole('button', { name: /Scope$/ })).toHaveTextContent('All projects');
	});
	it('debounces typing, hides old results immediately, and clears without a request', async () => {
		const { searches } = setup();
		await screen.findByRole('link', { name: /Revenue model/ });
		const input = screen.getByRole('searchbox');
		fireEvent.change(input, { target: { value: 'new' } });
		fireEvent.change(input, { target: { value: 'new phrase' } });
		expect(screen.queryByRole('link', { name: /Revenue model/ })).not.toBeInTheDocument();
		expect(searches).toHaveLength(1);
		await waitFor(() => expect(searches).toHaveLength(2));
		expect(searches[1]?.searchParams.get('q')).toBe('new phrase');
		fireEvent.change(input, { target: { value: '   ' } });
		expect(screen.queryByRole('link', { name: /Revenue model/ })).not.toBeInTheDocument();
		expect(screen.getByText('Search your workspace')).toBeVisible();
		expect(searches).toHaveLength(2);
	});
	it('cancels an old request and ignores its late response after scope changes', async () => {
		const pending = deferred<Response>();
		let oldSignal: AbortSignal | null | undefined;
		const { user } = setup({
			search: async (url, signal) => {
				if (!url.searchParams.has('project_id')) {
					oldSignal = signal;
					return pending.promise;
				}
				return response([{ ...hit, title: 'Current project result' }]);
			},
		});
		await waitFor(() => expect(oldSignal).toBeDefined());
		await selectSearchFilter(user, 'Scope', 'Beta');
		expect(await screen.findByRole('link', { name: /Current project result/ })).toBeVisible();
		expect(oldSignal?.aborted).toBe(true);
		await act(async () => pending.resolve(response([{ ...hit, title: 'Stale result' }])));
		expect(screen.queryByRole('link', { name: /Stale result/ })).not.toBeInTheDocument();
	});
	it('shows partial coverage without claiming an exhaustive empty result', async () => {
		setup({ search: async () => response([], true) });
		expect(await screen.findByText('Some content could not be searched.')).toBeVisible();
		expect(screen.getByText('No matches in the content searched')).toBeVisible();
		expect(screen.queryByText('No results found')).not.toBeInTheDocument();
	});
	it('handles provider failure and retries without exposing upstream details', async () => {
		let attempts = 0;
		const { user } = setup({
			search: async () =>
				++attempts === 1
					? jsonError('SERVICE_UNAVAILABLE', 'secret upstream error', 503)
					: response(),
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('Search could not finish');
		expect(screen.queryByText(/secret upstream/)).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry search' }));
		expect(await screen.findByRole('link', { name: /Revenue model/ })).toBeVisible();
	});
	it('removes previous results when reauthorization fails', async () => {
		let revoked = false;
		const { client } = setup({
			search: async () => (revoked ? jsonError('FORBIDDEN', 'Forbidden', 403) : response()),
		});
		await screen.findByRole('link', { name: /Revenue model/ });
		revoked = true;
		await act(async () => {
			await client.invalidateQueries({ queryKey: ['workspace-search'] });
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('no longer have access');
		expect(screen.queryByRole('link', { name: /Revenue model/ })).not.toBeInTheDocument();
	});
	it.each([{ appOnly: true }, { enabled: false }])(
		'does not query when search is unavailable (%j)',
		async (options) => {
			const { searches } = setup(options);
			expect(await screen.findByText(/Search is not (available|enabled)/)).toBeVisible();
			expect(searches).toHaveLength(0);
			expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
		},
	);
	it.each(['kind=invalid', 'kind=chat', 'mode=unknown', `q=${'x'.repeat(257)}`])(
		'rejects invalid URL filters instead of silently broadening search (%s)',
		async (filter) => {
			const { searches } = setup({
				route: `/search?${filter.startsWith('q=') ? '' : 'q=revenue&'}${filter}`,
			});
			expect(await screen.findByRole('alert')).toBeVisible();
			expect(searches).toHaveLength(0);
		},
	);
	it('offers hybrid search only when enabled and sends the selected mode', async () => {
		const { user, searches } = setup({ semantic: true });
		await user.click(
			await screen.findByRole('checkbox', { name: 'Include related notebook content' }),
		);
		await waitFor(() => expect(searches.at(-1)?.searchParams.get('mode')).toBe('hybrid'));
	});
	it('keeps a directly linked project selected when its roster is unavailable', async () => {
		setup({ route: '/projects/archived/search?q=revenue', projectsFail: true });
		await screen.findByRole('link', { name: /Revenue model/ });
		expect(screen.getByRole('button', { name: /Scope$/ })).toHaveTextContent('Alpha');
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not load project choices');
	});
	it('renders snippet HTML as text and skips invalid or overlapping highlight ranges', () => {
		renderWithClient(
			<p data-testid="snippet">
				<SearchSnippet
					snippet={{
						text: '<script>abc</script>',
						highlights: [
							{ start: -1, end: 2 },
							{ start: 8, end: 11 },
							{ start: 9, end: 12 },
							{ start: 12, end: 99 },
						],
					}}
				/>
			</p>,
			{ toaster: false },
		);
		const snippet = screen.getByTestId('snippet');
		expect(snippet).toHaveTextContent('<script>abc</script>');
		expect(snippet.querySelector('script')).toBeNull();
		expect(within(snippet).getByText('abc', { selector: 'mark' })).toBeVisible();
		expect(snippet.querySelectorAll('mark')).toHaveLength(1);
	});
});
