import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StartupProgress } from './StartupProgress';

afterEach(() => vi.useRealTimers());

it('shows the current stage, elapsed time, and plain-text adapter details', async () => {
	vi.useFakeTimers();
	// A skewed server clock must not shift the client-side elapsed badge.
	const time = new Date(Date.now() + 60_000).toISOString();
	const { unmount } = render(
		<StartupProgress
			progress={{
				phase: 'workspace',
				detail: '<b>Copying files</b>',
				started_at: time,
				receivedAt: Date.now(),
				attempt: 1,
				observed: ['allocating', 'workspace'],
			}}
		/>,
	);
	expect(screen.getByText('Preparing workspace').closest('li')).toHaveAttribute(
		'aria-current',
		'step',
	);
	expect(screen.getByLabelText('Complete')).toBeInTheDocument();
	expect(screen.getByRole('status')).toHaveTextContent('<b>Copying files</b>');
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	expect(
		screen.getByText('Time in current step:', { exact: false }).parentElement,
	).toHaveTextContent('Time in current step: 2s');
	unmount();
});

it('does not mark unobserved stages complete', () => {
	render(
		<StartupProgress
			progress={{
				phase: 'starting',
				started_at: new Date().toISOString(),
				receivedAt: Date.now(),
				attempt: 2,
				observed: ['starting'],
			}}
		/>,
	);
	expect(screen.queryByLabelText('Complete')).toBeNull();
});
