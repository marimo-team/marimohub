import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installMatchMedia } from '@/test/render';
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

function renderControl(status?: Session['status']) {
	return render(
		<SessionControl
			session={status ? { ...session, status } : undefined}
			profiles={[]}
			allowOverride={false}
			isProvisioning={!status}
			onStop={() => {}}
		/>,
	);
}

describe('SessionControl status feedback', () => {
	it.each([
		[undefined, 'Starting', true],
		['starting', 'Starting', true],
		['terminating', 'Stopping', true],
		['running', 'Running', false],
	] as const)('shows %s with the expected activity indicator', (status, label, pulsing) => {
		renderControl(status);
		const trigger = screen.getByRole('button', { name: `Session ${label} — details` });
		expect(trigger.querySelector('.animate-pulse') !== null).toBe(pulsing);
	});

	it('keeps session controls available for an unrecognized server status', () => {
		renderControl('restarting' as Session['status']);
		expect(screen.getByRole('button', { name: 'Session Unknown — details' })).toBeVisible();
	});
});
