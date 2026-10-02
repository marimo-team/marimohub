import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { HostBridgeOptions } from '@marimo-hub/notebook-bridge/host';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLinkPage } from './AppLinkPage';
import { NotebookFrame } from './NotebookFrame';

const connections = vi.hoisted(
	() => [] as { options: HostBridgeOptions; dispose: ReturnType<typeof vi.fn> }[],
);
vi.mock(import('@marimo-hub/notebook-bridge/host'), async (importOriginal) => ({
	...(await importOriginal()),
	createHostBridge: (options: HostBridgeOptions) => {
		const dispose = vi.fn();
		connections.push({ options, dispose });
		return { status: 'connected', dispose };
	},
}));
afterEach(() => {
	connections.length = 0;
	vi.unstubAllGlobals();
});

function Location() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<output data-testid="location">
				{location.pathname}
				{location.search}
				{location.hash}
			</output>
			<button onClick={() => void navigate(-1)}>Back</button>
		</>
	);
}

it.each(['/', '/prefix'])(
	'routes app links under %s and ignores queries from the previous frame',
	(basename) => {
		const onQuery = vi.fn(() => true);
		render(
			<MemoryRouter
				basename={basename}
				initialEntries={[`${basename === '/' ? '' : basename}/app/source?id=old`]}
			>
				<Location />
				<NotebookFrame
					title="Notebook"
					src="https://sandbox.example/?access_token=secret"
					sandboxUrl="https://sandbox.example/?access_token=secret"
					onQuery={onQuery}
				/>
			</MemoryRouter>,
		);
		const oldFrame = screen.getByTitle('Notebook');
		const connection = connections.at(-1)!;
		expect(connection.options.appBaseUrl).toBe(
			`${window.location.origin}${basename === '/' ? '' : basename}/app/`,
		);
		act(() => {
			expect(
				connection.options.onNavigateApp!({
					slug: 'team/match',
					entries: [
						['id', 'xyz'],
						['tag', 'a'],
						['tag', 'b'],
					],
					hash: '#result',
				}),
			).toBe(true);
			expect(connection.options.onQuery({ revision: 1, entries: [['stale', 'ignored']] })).toBe(
				false,
			);
		});
		expect(screen.getByTestId('location')).toHaveTextContent(
			'/app/team/match?id=xyz&tag=a&tag=b#result',
		);
		expect(onQuery).not.toHaveBeenCalled();
		expect(screen.getByTitle('Notebook')).not.toBe(oldFrame);
		expect(connection.dispose).toHaveBeenCalledOnce();
		expect(connection.options.onNavigateApp!({ slug: 'ignored', entries: [], hash: '' })).toBe(
			false,
		);
		fireEvent.click(screen.getByText('Back'));
		expect(screen.getByTestId('location')).toHaveTextContent('/app/source?id=old');
	},
);

it('reconnects even when an app link points to the current URL', () => {
	render(
		<MemoryRouter initialEntries={['/app/match?id=xyz']}>
			<NotebookFrame
				title="Notebook"
				src="https://sandbox.example/"
				sandboxUrl="https://sandbox.example/"
			/>
		</MemoryRouter>,
	);
	const oldFrame = screen.getByTitle('Notebook');
	act(() => {
		connections.at(-1)!.options.onNavigateApp!({
			slug: 'match',
			entries: [['id', 'xyz']],
			hash: '',
		});
	});
	expect(screen.getByTitle('Notebook')).not.toBe(oldFrame);
});

it.each([403, 404, 503])(
	'shows target resolution failure %s without starting a session or accepting old queries',
	async (status) => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: {
							code:
								status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE',
							message: 'Target unavailable',
						},
					}),
					{ status, headers: { 'content-type': 'application/json' } },
				),
		);
		vi.stubGlobal('fetch', fetch);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={['/source']}>
					<Location />
					<Routes>
						<Route
							path="/source"
							element={
								<NotebookFrame
									title="Source"
									src="https://sandbox.example/"
									sandboxUrl="https://sandbox.example/"
								/>
							}
						/>
						<Route path="/app/*" element={<AppLinkPage />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const connection = connections.at(-1)!;
		act(() => {
			connection.options.onNavigateApp!({
				slug: 'team/missing',
				entries: [['id', 'xyz']],
				hash: '',
			});
		});
		expect(
			await screen.findByRole('heading', {
				name: status === 404 ? 'App link not found' : 'Unable to open app',
			}),
		).toBeInTheDocument();
		expect(screen.queryByTitle('Source')).not.toBeInTheDocument();
		expect(screen.getByTestId('location')).toHaveTextContent('/app/team/missing?id=xyz');
		expect(connection.dispose).toHaveBeenCalledOnce();
		expect(connection.options.onQuery({ revision: 1, entries: [['old', 'value']] })).toBe(false);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]).toEqual(
			expect.arrayContaining([expect.stringContaining('/deep-links/team%2Fmissing')]),
		);
	},
);
