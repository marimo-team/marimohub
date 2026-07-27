import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@/types';
import { AppSessionIndicator, isAppStale } from './AppSessionIndicator';

function makeAppSession(overrides: Partial<Session> = {}): Session {
	return {
		session_id: 'sess-app',
		notebook_id: 'nb-1',
		project_id: 'proj-1',
		user_id: 'user_1',
		status: 'running',
		mode: 'app',
		source_version_id: 'ver-head',
		started_at: '2026-06-24T12:00:00Z',
		last_heartbeat: '2026-06-24T12:00:00Z',
		...overrides,
	} as Session;
}

function renderIndicator(
	session: Session,
	{
		canControl = true,
		canOpen = false,
		editActive = false,
		headVersion = 'ver-head',
	}: {
		canControl?: boolean;
		canOpen?: boolean;
		editActive?: boolean;
		/** A function to model a head that moves between popover opens. */
		headVersion?: string | (() => string);
	} = {},
) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.includes('/notebooks/')
				? {
						meta: { id: 'nb-1', title: 'NB', author: 'user_1' },
						source: {
							type: 'local',
							current_version_id: typeof headVersion === 'function' ? headVersion() : headVersion,
						},
					}
				: {};
			return new Response(JSON.stringify({ success: true, data: body }), {
				headers: { 'content-type': 'application/json' },
			});
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<AppSessionIndicator
			session={session}
			canControl={canControl}
			canOpen={canOpen}
			editActive={editActive}
			onStop={vi.fn()}
			onRestart={vi.fn()}
		/>,
		{ wrapper },
	);
}

beforeEach(() => {
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

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('isAppStale', () => {
	it('is stale only when both versions are known and differ', () => {
		expect(isAppStale({ source_version_id: 'a' }, 'b')).toBe(true);
		expect(isAppStale({ source_version_id: 'a' }, 'a')).toBe(false);
		expect(isAppStale({ source_version_id: undefined }, 'b')).toBe(false);
		expect(isAppStale({ source_version_id: 'a' }, null)).toBe(false);
		expect(isAppStale({ source_version_id: 'a' }, undefined)).toBe(false);
	});
});

describe('AppSessionIndicator', () => {
	it('renders nothing for a terminal session', () => {
		const { container } = renderIndicator(makeAppSession({ status: 'terminated' }));
		expect(container.firstChild).toBeNull();
	});

	it('opens a popover with attribution, connections, and controls', async () => {
		renderIndicator(makeAppSession({ active_connections: 3 }));
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('App running')).toBeInTheDocument();
		expect(screen.getByText('~3')).toBeInTheDocument();
		expect(screen.getByText('Restart')).toBeInTheDocument();
		expect(screen.getByText('Stop')).toBeInTheDocument();
	});

	it('hides the controls for viewers (apps not granted → editor-only copy)', async () => {
		renderIndicator(makeAppSession(), { canControl: false });
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('App running')).toBeInTheDocument();
		expect(screen.queryByText('Restart')).toBeNull();
		expect(screen.queryByText('Stop')).toBeNull();
		expect(screen.getByText(/editor-only/)).toBeInTheDocument();
	});

	it('viewer who may open the app sees stop/restart-only copy instead', async () => {
		renderIndicator(makeAppSession(), { canControl: false, canOpen: true });
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('App running')).toBeInTheDocument();
		expect(screen.queryByText('Restart')).toBeNull();
		expect(screen.queryByText('Stop')).toBeNull();
		expect(screen.getByText(/Only editors can stop or restart/)).toBeInTheDocument();
		expect(screen.queryByText(/editor-only/)).toBeNull();
	});

	it('suppresses the stale hint while the notebook is being edited', async () => {
		renderIndicator(makeAppSession({ source_version_id: 'ver-old' }), {
			headVersion: 'ver-head',
			editActive: true,
		});
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText('App running')).toBeInTheDocument();
		expect(screen.queryByText(/Restart to update/)).toBeNull();
	});

	it('shows the stale hint when the app trails the notebook head', async () => {
		renderIndicator(makeAppSession({ source_version_id: 'ver-old' }), {
			headVersion: 'ver-head',
		});
		await userEvent.click(screen.getByRole('button'));

		expect(await screen.findByText(/Restart to update/)).toBeInTheDocument();
	});

	// A version committed server-side (an edit session ending) invalidates
	// nothing on the client, so a cached head would hide the hint for 5 minutes.
	it('re-reads the notebook head each time the popover opens', async () => {
		let head = 'ver-head';
		renderIndicator(makeAppSession({ source_version_id: 'ver-head' }), {
			headVersion: () => head,
		});
		const trigger = screen.getByRole('button');

		await userEvent.click(trigger);
		expect(await screen.findByText('App running')).toBeInTheDocument();
		expect(screen.queryByText(/Restart to update/)).toBeNull();

		await userEvent.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByText('App running')).toBeNull());

		head = 'ver-next';
		await userEvent.click(trigger);

		expect(await screen.findByText(/Restart to update/)).toBeInTheDocument();
	});
});
