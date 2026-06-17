import type { ReactNode } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@/types';
import { SessionStatusDot } from './SessionStatusDot';

function makeSession(status: Session['status']): Session {
	return {
		session_id: 'sess-0000000000000000',
		notebook_id: 'nb-0000000000000000',
		project_id: 'proj-000000000000000',
		user_id: 'user_1',
		status,
		started_at: '2026-06-24T12:00:00Z',
		last_heartbeat: '2026-06-24T12:00:00Z',
	};
}

function renderDot(session: Session | undefined) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify({ success: true, data: {} }), {
					headers: { 'content-type': 'application/json' },
				}),
		),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<SessionStatusDot session={session} />, { wrapper });
}

/** The status dot lives inside the popover trigger button. */
function dot(): Element | null {
	return screen.getByRole('button').querySelector('span');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SessionStatusDot', () => {
	it('renders a green Running dot', () => {
		renderDot(makeSession('running'));
		expect(dot()).toHaveClass('bg-green-500');
		expect(dot()).not.toHaveClass('animate-pulse');
	});

	it('renders a pulsing amber Starting dot', () => {
		renderDot(makeSession('starting'));
		expect(dot()).toHaveClass('bg-amber-500');
		expect(dot()).toHaveClass('animate-pulse');
	});

	it('renders a pulsing orange Stopping dot for a terminating session', () => {
		renderDot(makeSession('terminating'));
		expect(dot()).toHaveClass('bg-orange-500');
		expect(dot()).toHaveClass('animate-pulse');
	});

	it('shows the status in a tooltip on focus', async () => {
		const user = userEvent.setup();
		renderDot(makeSession('running'));

		await user.tab();
		expect(screen.getByRole('button')).toHaveFocus();
		expect(await screen.findByRole('tooltip')).toHaveTextContent('Running');
	});

	it('opens the session details popover on press', async () => {
		const user = userEvent.setup();
		renderDot(makeSession('running'));

		await user.click(screen.getByRole('button'));
		expect(await screen.findByText('Started by')).toBeInTheDocument();
	});

	it.each(['terminated', 'expired'] as const)(
		'renders nothing for terminal status: %s',
		(status) => {
			const { container } = renderDot(makeSession(status));
			expect(container).toBeEmptyDOMElement();
		},
	);

	it('renders nothing when there is no session', () => {
		const { container } = renderDot(undefined);
		expect(container).toBeEmptyDOMElement();
	});
});
