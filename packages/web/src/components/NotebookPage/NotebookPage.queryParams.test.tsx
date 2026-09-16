import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { useTheme } from '@/context/ThemeContext';
import { makeFetch, renderPage, runningSession, sessionPosts } from './NotebookPage.testWorld';

function NavigationControls() {
	const navigate = useNavigate();
	const { toggleTheme } = useTheme();
	return (
		<>
			<button onClick={() => void navigate('?id=456')}>Change query</button>
			<button onClick={() => void navigate('?')}>Clear query</button>
			<button onClick={() => void navigate('?id=123&session_id=evil&theme=dark')}>
				Reserved query
			</button>
			<button onClick={() => void navigate(-1)}>Back</button>
			<button onClick={() => void navigate(1)}>Forward</button>
			<button onClick={toggleTheme}>Toggle test theme</button>
		</>
	);
}

afterEach(() => vi.useRealTimers());

describe('NotebookPage query parameters', () => {
	it.each(['app', 'edit'] as const)(
		'uses the latest deep link after a failed %s startup is retried',
		async (variant) => {
			const options: Parameters<typeof makeFetch>[0] = {
				role: 'editor',
				createError: { code: 'COMPUTE_UNAVAILABLE', message: 'Compute unavailable', status: 503 },
				session: runningSession({ mode: variant }),
			};
			const impl = makeFetch(options);
			const { container } = renderPage(variant, {
				search: '?id=123&access_token=evil',
				controls: <NavigationControls />,
			});
			await screen.findByText('Compute unavailable');
			expect(container.querySelector('iframe')).toBeNull();
			fireEvent.click(screen.getByText('Change query'));
			expect(sessionPosts(impl)).toHaveLength(1);
			options.createError = undefined;
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
			const frame = await screen.findByTitle('Forecast');
			expect(new URL(frame.getAttribute('src')!).searchParams.get('id')).toBe('456');
			expect(sessionPosts(impl)).toHaveLength(2);
		},
	);

	it('uses the current query when a slow startup becomes ready', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const options: Parameters<typeof makeFetch>[0] = {
			role: 'editor',
			session: runningSession({ mode: 'app', status: 'starting', sandbox_url: undefined }),
		};
		const impl = makeFetch(options);
		const { container } = renderPage('app', {
			search: '?id=123',
			controls: <NavigationControls />,
		});
		await waitFor(() => expect(sessionPosts(impl)).toHaveLength(1));
		expect(container.querySelector('iframe')).toBeNull();
		fireEvent.click(screen.getByText('Change query'));
		options.session = runningSession({ mode: 'app' });
		await act(() => vi.advanceTimersByTimeAsync(2_000));
		const frame = await screen.findByTitle('Forecast');
		expect(new URL(frame.getAttribute('src')!).searchParams.get('id')).toBe('456');
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('preserves the deep link after readmission, without carrying over old credentials', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const options: Parameters<typeof makeFetch>[0] = {
			role: 'editor',
			session: runningSession({
				mode: 'app',
				sandbox_url: 'https://old.example/?access_token=old',
			}),
		};
		const impl = makeFetch(options);
		renderPage('app', { search: '?id=123&access_token=evil' });
		const initial = await screen.findByTitle('Forecast');
		options.session = runningSession({ mode: 'app', status: 'terminated', sandbox_url: undefined });
		options.projectSessions = [
			runningSession({
				mode: 'app',
				session_id: 'sess-2',
				sandbox_url: 'https://new.example/?access_token=new',
			}),
		];
		await act(() => vi.advanceTimersByTimeAsync(30_000));
		expect(screen.queryByTitle('Forecast')).toBeNull();
		options.session = options.projectSessions[0];
		fireEvent.click(screen.getByRole('button', { name: 'Restart app' }));
		const frame = await screen.findByTitle('Forecast');
		expect(frame).not.toBe(initial);
		expect(frame).toHaveAttribute(
			'src',
			'https://new.example/?access_token=new&id=123&theme=light&show-code=false',
		);
		expect(sessionPosts(impl)).toHaveLength(2);
	});

	it('removes the live frame when access is revoked and query changes cannot restore it', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const options: Parameters<typeof makeFetch>[0] = {
			role: 'editor',
			session: runningSession({ mode: 'app' }),
		};
		const impl = makeFetch(options);
		const { container } = renderPage('app', {
			search: '?id=123',
			controls: <NavigationControls />,
		});
		await screen.findByTitle('Forecast');
		options.session = runningSession({
			mode: 'app',
			sandbox_url: undefined,
			can: { attach: false, stop: false, surfaces: { vscode: false, opencode: false } },
		});
		await act(() => vi.advanceTimersByTimeAsync(30_000));
		expect(screen.getByText('Access ended')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Change query'));
		expect(container.querySelector('iframe')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Restart app' })).toBeNull();
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('does not retry a forbidden app when query parameters change', async () => {
		const impl = makeFetch({
			role: 'viewer',
			createError: { code: 'FORBIDDEN', message: 'Access denied', status: 403 },
		});
		const { container } = renderPage('app', {
			search: '?id=123&access_token=evil',
			controls: <NavigationControls />,
		});
		await screen.findByText('Access denied');
		fireEvent.click(screen.getByText('Change query'));
		expect(container.querySelector('iframe')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('removes stale parameters when the outer query is cleared', async () => {
		const impl = makeFetch({ role: 'editor', session: runningSession({ mode: 'app' }) });
		renderPage('app', { search: '?id=123&tag=one&tag=two', controls: <NavigationControls /> });
		const initial = await screen.findByTitle('Forecast');
		fireEvent.click(screen.getByText('Clear query'));
		const frame = screen.getByTitle('Forecast');
		expect(frame).not.toBe(initial);
		expect(frame).toHaveAttribute(
			'src',
			'https://sandbox.example/kernel?theme=light&show-code=false',
		);
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('does not reload when changed query values collide with trusted parameters', async () => {
		const impl = makeFetch({
			role: 'editor',
			session: runningSession({ mode: 'app', sandbox_url: 'https://sandbox.example/?id=trusted' }),
		});
		renderPage('app', { search: '?id=123', controls: <NavigationControls /> });
		const initial = await screen.findByTitle('Forecast');
		fireEvent.click(screen.getByText('Change query'));
		expect(screen.getByTitle('Forecast')).toBe(initial);
		expect(new URL(initial.getAttribute('src')!).searchParams.get('id')).toBe('trusted');
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('offers Copy URL on the app page without offering Run as app again', async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(() => Promise.resolve());
		vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
		makeFetch({ role: 'editor', session: runningSession({ mode: 'app' }) });
		renderPage('app', { search: '?id=123&access_token=evil' });
		await user.click(await screen.findByRole('button', { name: 'Share notebook' }));
		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).toBeNull();
		await user.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
		expect(writeText).toHaveBeenCalledWith(
			`${window.location.origin}/projects/proj-x/notebooks/nb-1/app?id=123`,
		);
	});

	it.each(['app', 'edit'] as const)('forwards filtered parameters in %s mode', async (variant) => {
		const impl = makeFetch({
			role: 'editor',
			session: runningSession({
				mode: variant,
				sandbox_url: 'https://sandbox.example/kernel?access_token=trusted&provider=one#cell',
			}),
		});
		renderPage(variant, {
			search: '?id=123&tag=one&tag=two&empty=&access_token=evil&session_id=evil&provider=evil',
		});
		const frame = await screen.findByTitle('Forecast');
		const url = new URL(frame.getAttribute('src')!);
		expect(url.searchParams.get('id')).toBe('123');
		expect(url.searchParams.getAll('tag')).toEqual(['one', 'two']);
		expect(url.searchParams.get('empty')).toBe('');
		expect(url.searchParams.getAll('access_token')).toEqual(['trusted']);
		expect(url.searchParams.getAll('provider')).toEqual(['one']);
		expect(url.searchParams.has('session_id')).toBe(false);
		expect(url.searchParams.get('show-code')).toBe(variant === 'app' ? 'false' : null);
		expect(url.hash).toBe('#cell');
		expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
		expect(sessionPosts(impl)).toHaveLength(1);
		expect(String(sessionPosts(impl)[0][1]?.body)).not.toContain('123');
	});

	it.each(['app', 'edit'] as const)(
		'reloads only the frame on query navigation in %s mode',
		async (variant) => {
			const impl = makeFetch({ role: 'editor', session: runningSession({ mode: variant }) });
			renderPage(variant, { search: '?id=123', controls: <NavigationControls /> });
			const initial = await screen.findByTitle('Forecast');
			fireEvent.click(screen.getByText('Change query'));
			const changed = screen.getByTitle('Forecast');
			expect(changed).not.toBe(initial);
			expect(new URL(changed.getAttribute('src')!).searchParams.get('id')).toBe('456');
			fireEvent.click(screen.getByText('Back'));
			const back = screen.getByTitle('Forecast');
			expect(back).not.toBe(changed);
			expect(back.getAttribute('src')).toBe(initial.getAttribute('src'));
			fireEvent.click(screen.getByText('Forward'));
			expect(screen.getByTitle('Forecast').getAttribute('src')).toBe(changed.getAttribute('src'));
			expect(sessionPosts(impl)).toHaveLength(1);
		},
	);

	it('keeps the frame mounted through reserved query changes, theme changes, and heartbeats', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const impl = makeFetch({ role: 'editor', session: runningSession({ mode: 'app' }) });
		renderPage('app', { search: '?id=123', controls: <NavigationControls /> });
		const initial = await screen.findByTitle('Forecast');
		fireEvent.click(screen.getByText('Reserved query'));
		fireEvent.click(screen.getByText('Toggle test theme'));
		expect(document.documentElement).toHaveClass('dark');
		expect(screen.getByTitle('Forecast')).toBe(initial);
		const before = impl.mock.calls.length;
		await act(() => vi.advanceTimersByTimeAsync(30_000));
		expect(
			impl.mock.calls
				.slice(before)
				.some(([url]) => String(url).endsWith('/sessions/sess-1/heartbeat')),
		).toBe(true);
		expect(screen.getByTitle('Forecast')).toBe(initial);
		expect(new URL(initial.getAttribute('src')!).searchParams.get('theme')).toBe('light');
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('does not pass notebook parameters to a static viewer', async () => {
		const impl = makeFetch({ role: 'viewer', viewerMode: 'static', html: '<p>Static output</p>' });
		const { container } = renderPage('edit', { search: '?id=123' });
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		const frame = container.querySelector('iframe')!;
		expect(frame).not.toHaveAttribute('src');
		expect(frame.getAttribute('srcdoc')).toContain('Static output');
		expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
		expect(sessionPosts(impl)).toHaveLength(0);
	});
});
