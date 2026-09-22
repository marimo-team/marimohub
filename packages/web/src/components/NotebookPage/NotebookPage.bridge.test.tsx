import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useLocation, useNavigate } from 'react-router-dom';
import type { HostBridgeOptions } from '@marimo-hub/notebook-bridge/host';
import { makeFetch, renderPage, runningSession, sessionPosts } from './NotebookPage.testWorld';

const connections = vi.hoisted(
	() => [] as { options: HostBridgeOptions; dispose: ReturnType<typeof vi.fn> }[],
);
vi.mock('@marimo-hub/notebook-bridge/host', () => ({
	createHostBridge: (options: HostBridgeOptions) => {
		const dispose = vi.fn();
		connections.push({ options, dispose });
		return { status: 'connected', dispose };
	},
}));
afterEach(() => {
	connections.length = 0;
});
function Controls() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<output data-testid="url">
				{location.pathname}
				{location.search}
				{location.hash}
			</output>
			<button onClick={() => void navigate('?id=external')}>External query</button>
			<button onClick={() => void navigate('?id=123')}>Original query</button>
			<button onClick={() => void navigate(-1)}>Go back</button>
			<button onClick={() => void navigate(1)}>Go forward</button>
			<button
				onClick={() =>
					void navigate(location.pathname + location.search + location.hash, {
						replace: true,
						state: { panel: 'kept' },
					})
				}
			>
				Set Hub state
			</button>
			<output data-testid="router-state">{JSON.stringify(location.state)}</output>
		</>
	);
}

describe('notebook URL mirroring', () => {
	it.each(['app', 'edit'] as const)(
		'reloads the %s iframe when explicit navigation returns to its original launch query',
		async (variant) => {
			const impl = makeFetch({ role: 'editor', session: runningSession({ mode: variant }) });
			renderPage(variant, { search: '?id=123', controls: <Controls /> });
			let initial = await screen.findByTitle('Forecast');
			const launchSrc = initial.getAttribute('src');
			for (const value of ['456', '789']) {
				const connection = connections.at(-1)!;
				act(() => {
					connection.options.onQuery({ revision: 1, entries: [['id', value]] });
				});
				expect(screen.getByTestId('url')).toHaveTextContent(`?id=${value}`);
				expect(screen.getByTitle('Forecast')).toBe(initial);
				fireEvent.click(screen.getByText('Set Hub state'));
				expect(screen.getByTitle('Forecast')).toBe(initial);
				fireEvent.click(screen.getByText('Original query'));
				const replacement = screen.getByTitle('Forecast');
				expect(replacement).not.toBe(initial);
				expect(replacement.getAttribute('src')).toBe(launchSrc);
				expect(screen.getByTestId('url')).toHaveTextContent('?id=123');
				expect(connection.dispose).toHaveBeenCalledOnce();
				expect(connection.options.onQuery({ revision: 2, entries: [['late', 'ignored']] })).toBe(
					false,
				);
				initial = replacement;
			}
			expect(sessionPosts(impl)).toHaveLength(1);
		},
	);
	it.each(['app', 'edit'] as const)(
		'updates sharing and router state without reconnecting the %s iframe',
		async (variant) => {
			const user = userEvent.setup();
			const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
			const impl = makeFetch({ role: 'editor', session: runningSession({ mode: variant }) });
			renderPage(variant, { search: '?id=123#anchor', controls: <Controls /> });
			const initial = await screen.findByTitle('Forecast');
			const connection = connections.at(-1)!;
			const count = connections.length;
			act(() => {
				connection.options.onQuery({
					revision: 1,
					entries: [
						['id', '456'],
						['tag', 'one'],
						['tag', 'two'],
					],
				});
			});
			expect(screen.getByTestId('url')).toHaveTextContent('?id=456&tag=one&tag=two#anchor');
			expect(screen.getByTitle('Forecast')).toBe(initial);
			expect(initial.getAttribute('src')).toContain('id=123');
			expect(connections).toHaveLength(count);
			await user.click(
				screen.getByRole('button', { name: variant === 'app' ? 'Share app' : 'Share notebook' }),
			);
			await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
			expect(writeText.mock.calls.at(-1)?.[0]).toContain('?id=456&tag=one&tag=two');
			act(() => {
				connection.options.onQuery({ revision: 2, entries: [] });
			});
			expect(screen.getByTestId('url').textContent).not.toContain('?');
			expect(screen.getByTitle('Forecast')).toBe(initial);
			fireEvent.click(screen.getByText('External query'));
			expect(screen.getByTitle('Forecast')).not.toBe(initial);
			expect(screen.getByTitle('Forecast').getAttribute('src')).toContain('id=external');
			expect(connection.dispose).toHaveBeenCalledOnce();
			act(() => {
				expect(connection.options.onQuery({ revision: 3, entries: [['late', 'ignored']] })).toBe(
					false,
				);
			});
			expect(screen.getByTestId('url')).toHaveTextContent('?id=external');
			expect(sessionPosts(impl)).toHaveLength(1);
		},
	);
	it('protects host and provider parameters and retries with the latest mirrored URL', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			makeFetch({
				role: 'editor',
				session: runningSession({
					mode: 'app',
					sandbox_url: 'https://sandbox.example/?provider=private',
				}),
			});
			renderPage('app', { search: '?id=123&theme=dark', controls: <Controls /> });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			const initial = screen.getByTitle('Forecast');
			const connection = connections.at(-1)!;
			expect(connections[0].options.excludedKeys).toEqual(['provider']);
			act(() => {
				connection.options.onQuery({
					revision: 1,
					entries: [
						['id', 'new'],
						['theme', 'evil'],
						['provider', 'private'],
						['access_token', 'secret'],
					],
				});
			});
			expect(screen.getByTestId('url')).toHaveTextContent('?theme=dark&id=new');
			await act(() => vi.advanceTimersByTimeAsync(15_000));
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
			expect(screen.getByTitle('Forecast')).not.toBe(initial);
			expect(screen.getByTitle('Forecast').getAttribute('src')).toContain('id=new');
			expect(connection.dispose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
	it('disposes on revoked access and rejects late messages', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			const options: Parameters<typeof makeFetch>[0] = {
				role: 'editor',
				session: runningSession({ mode: 'app' }),
			};
			makeFetch(options);
			renderPage('app', { search: '?id=123', controls: <Controls /> });
			await screen.findByTitle('Forecast');
			const connection = connections.at(-1)!;
			options.session = runningSession({
				mode: 'app',
				sandbox_url: undefined,
				can: { attach: false, stop: false },
			});
			await act(() => vi.advanceTimersByTimeAsync(30_000));
			expect(screen.getByText('Access ended')).toBeInTheDocument();
			expect(connection.dispose).toHaveBeenCalledOnce();
			act(() => {
				expect(connection.options.onQuery({ revision: 9, entries: [['late', 'ignored']] })).toBe(
					false,
				);
			});
			expect(screen.getByTestId('url')).toHaveTextContent('?id=123');
		} finally {
			vi.useRealTimers();
		}
	});
	it('treats Back and Forward as explicit navigation despite a saved bridge marker', async () => {
		makeFetch({ role: 'editor', session: runningSession({ mode: 'app' }) });
		renderPage('app', { search: '?id=123#anchor', controls: <Controls /> });
		const original = await screen.findByTitle('Forecast');
		fireEvent.click(screen.getByText('Set Hub state'));
		const connection = connections.at(-1)!;
		act(() => {
			connection.options.onQuery({ revision: 1, entries: [['id', 'mirrored']] });
		});
		expect(screen.getByTestId('router-state')).toHaveTextContent('"panel":"kept"');
		expect(screen.getByTitle('Forecast')).toBe(original);
		fireEvent.click(screen.getByText('External query'));
		const external = screen.getByTitle('Forecast');
		fireEvent.click(screen.getByText('Go back'));
		await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('?id=mirrored#anchor'));
		const back = screen.getByTitle('Forecast');
		expect(back).not.toBe(original);
		expect(back).not.toBe(external);
		expect(back.getAttribute('src')).toContain('id=mirrored');
		fireEvent.click(screen.getByText('Go forward'));
		await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('?id=external'));
		expect(screen.getByTitle('Forecast')).not.toBe(back);
		expect(screen.getByTitle('Forecast').getAttribute('src')).toContain('id=external');
		expect(connection.options.onQuery({ revision: 99, entries: [['stale', 'ignored']] })).toBe(
			false,
		);
	});
	it('preserves mirrored parameters when the user re-enters through app admission', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			const options: Parameters<typeof makeFetch>[0] = {
				role: 'editor',
				session: runningSession({
					mode: 'app',
					sandbox_url: 'https://old.example/?access_token=old&provider=old',
				}),
			};
			const impl = makeFetch(options);
			renderPage('app', { search: '?id=123', controls: <Controls /> });
			const initial = await screen.findByTitle('Forecast');
			const connection = connections.at(-1)!;
			act(() => {
				connection.options.onQuery({
					revision: 1,
					entries: [
						['id', 'latest'],
						['tag', 'one'],
						['tag', 'two'],
					],
				});
			});
			options.session = runningSession({
				mode: 'app',
				status: 'terminated',
				sandbox_url: undefined,
			});
			options.projectSessions = [
				runningSession({
					mode: 'app',
					session_id: 'other-session',
					sandbox_url: 'https://other.example/?access_token=other',
				}),
			];
			await act(() => vi.advanceTimersByTimeAsync(30_000));
			expect(screen.getByText('App stopped')).toBeInTheDocument();
			expect(screen.queryByTitle('Forecast')).not.toBeInTheDocument();
			expect(sessionPosts(impl)).toHaveLength(1);
			expect(connection.dispose).toHaveBeenCalledOnce();
			options.session = runningSession({
				mode: 'app',
				session_id: 'new-session',
				sandbox_url: 'https://new.example/?access_token=new&provider=new',
			});
			fireEvent.click(screen.getByRole('button', { name: 'Restart app' }));
			const replacement = await screen.findByTitle('Forecast');
			expect(sessionPosts(impl)).toHaveLength(2);
			expect(replacement).not.toBe(initial);
			const url = new URL(replacement.getAttribute('src')!);
			expect(url.origin).toBe('https://new.example');
			expect(url.searchParams.get('access_token')).toBe('new');
			expect(url.searchParams.get('provider')).toBe('new');
			expect(url.searchParams.get('id')).toBe('latest');
			expect(url.searchParams.getAll('tag')).toEqual(['one', 'two']);
			expect(connection.dispose).toHaveBeenCalledOnce();
			expect(connection.options.onQuery({ revision: 99, entries: [] })).toBe(false);
			expect(screen.getByTestId('url')).toHaveTextContent('?id=latest&tag=one&tag=two');
		} finally {
			vi.useRealTimers();
		}
	});
});
