import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMatchMedia, renderWithClient } from '@/test/render';
import type { Session } from '@/types';
import { SessionControl } from './SessionControl';

beforeEach(() => installMatchMedia());

const session: Session = {
	session_id: 'session-1',
	project_id: 'project-1',
	notebook_id: 'notebook-1',
	mode: 'edit',
	status: 'running',
	started_at: '2026-06-24T12:00:00Z',
	last_heartbeat: '2026-06-24T12:00:00Z',
	can: { attach: true, stop: true },
};

function renderControl({
	status,
	isProvisioning = false,
	error,
	onStop = () => {},
	onRestart,
}: {
	status?: Session['status'];
	isProvisioning?: boolean;
	error?: string;
	onStop?: () => void;
	onRestart?: () => void;
} = {}) {
	return renderWithClient(
		<SessionControl
			session={status ? { ...session, status } : undefined}
			profiles={[]}
			allowOverride={false}
			isProvisioning={isProvisioning}
			error={error}
			onStop={onStop}
			onRestart={onRestart}
		/>,
	);
}

describe('SessionControl status feedback', () => {
	it.each([
		[undefined, true, 'Starting', true],
		[undefined, false, 'Stopped', false],
		['starting', false, 'Starting', true],
		['terminating', false, 'Stopping', true],
		['running', false, 'Running', false],
		['failed', false, 'Failed', false],
		['expired', false, 'Expired', false],
	] as const)(
		'shows %s (provisioning: %s) as %s with the expected activity indicator',
		(status, isProvisioning, label, pulsing) => {
			renderControl({ status, isProvisioning });
			const trigger = screen.getByRole('button', { name: `Session ${label} — details` });
			expect(trigger.querySelector('.animate-pulse') !== null).toBe(pulsing);
		},
	);

	it('keeps session controls available for an unrecognized server status', () => {
		renderControl({ status: 'restarting' as Session['status'] });
		expect(screen.getByRole('button', { name: 'Session Unknown — details' })).toBeVisible();
	});

	it('shows a start error as Failed with the message in the popover', async () => {
		const user = userEvent.setup();
		renderControl({ isProvisioning: true, error: 'Quota exceeded' });
		await user.click(screen.getByRole('button', { name: 'Session Failed — details' }));
		expect(screen.getByText('Quota exceeded')).toHaveClass('text-destructive');
	});
});

describe('SessionControl actions', () => {
	it('offers Restart only when a restart handler is provided', async () => {
		const user = userEvent.setup();
		const onRestart = vi.fn();
		const { unmount } = renderControl({ status: 'running', onRestart });
		await user.click(screen.getByRole('button', { name: 'Session Running — details' }));
		await user.click(screen.getByRole('button', { name: 'Restart' }));
		expect(onRestart).toHaveBeenCalledOnce();
		unmount();

		renderControl({ status: 'running' });
		await user.click(screen.getByRole('button', { name: 'Session Running — details' }));
		expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
		expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
	});

	it('stops the session and closes the popover', async () => {
		const user = userEvent.setup();
		const onStop = vi.fn();
		renderControl({ status: 'running', onStop });
		await user.click(screen.getByRole('button', { name: 'Session Running — details' }));
		await user.click(screen.getByRole('button', { name: 'Stop' }));
		expect(onStop).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
	});
});
