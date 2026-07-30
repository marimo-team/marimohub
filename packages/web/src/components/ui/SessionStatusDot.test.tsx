import type { ReactNode } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@/types';
import { SessionStatusDot } from './SessionStatusDot';
import type { ComputeProfile } from '@/components/Notebook/ComputeProfileSelect';

function makeSession(status: Session['status']): Session {
	return {
		session_id: 'sess-0000000000000000',
		notebook_id: 'nb-0000000000000000',
		project_id: 'proj-000000000000000',
		user_id: 'user_1',
		status,
		mode: 'edit',
		can: { attach: true, stop: true },
		started_at: '2026-06-24T12:00:00Z',
		last_heartbeat: '2026-06-24T12:00:00Z',
	};
}

function renderDot(
	session: Session | undefined,
	profiles: ComputeProfile[] = [],
	selectedProfileName?: string,
) {
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
	return render(
		<SessionStatusDot
			session={session}
			profiles={profiles}
			selectedProfileName={selectedProfileName}
		/>,
		{ wrapper },
	);
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

	it('shows the session compute profile in details', async () => {
		const user = userEvent.setup();
		renderDot({ ...makeSession('running'), compute_profile: 'large' });

		await user.click(screen.getByRole('button'));
		expect(await screen.findByText('Compute')).toBeInTheDocument();
		expect(screen.getByText('large — platform default')).toBeInTheDocument();
	});

	it('shows current and next compute when the selected profile changed', async () => {
		const user = userEvent.setup();
		renderDot(
			{
				...makeSession('running'),
				compute_profile: 'small',
				compute_resources: { cpu: 1, memory_bytes: 2 * 1024 ** 3 },
			},
			[
				{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
				{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
			],
			'large',
		);

		await user.click(screen.getByRole('button'));
		expect(await screen.findByText('small — 1 CPU · 2 Gi')).toBeInTheDocument();
		expect(screen.getByText('large — 8 CPU · 32 Gi')).toBeInTheDocument();
		expect(screen.getByText('large on next restart')).toBeInTheDocument();
	});

	it('detects edited resources under the same profile name', async () => {
		const user = userEvent.setup();
		renderDot(
			{
				...makeSession('running'),
				compute_profile: 'small',
				compute_resources: { cpu: 1 },
			},
			[{ name: 'small', cpu: 2 }],
			'small',
		);

		await user.click(screen.getByRole('button'));
		expect(await screen.findByText('small — 1 CPU')).toBeInTheDocument();
		expect(screen.getByText('small — 2 CPU')).toBeInTheDocument();
		expect(screen.getByText('profile updated — restart to apply')).toBeInTheDocument();
	});

	it('uses snapshot-specific pending copy for restored sessions', async () => {
		const user = userEvent.setup();
		renderDot(
			{
				...makeSession('running'),
				compute_profile: 'small',
				compute_resources: { cpu: 1 },
				compute_from_snapshot: true,
			},
			[{ name: 'small', cpu: 2 }],
			'small',
		);

		await user.click(screen.getByRole('button'));
		expect(await screen.findByText('applies after snapshot is dropped')).toBeInTheDocument();
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
