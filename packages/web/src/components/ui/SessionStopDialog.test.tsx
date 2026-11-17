import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupUser } from '@/test/render';
import type { Session } from '@/types';
import { SessionStopDialog } from './SessionStopDialog';

const mocked = vi.hoisted(() => ({ decision: vi.fn(), current: undefined as unknown }));
vi.mock('@/api/sessionStop', () => ({
	currentStopDecision: () => mocked.current,
	subscribeStopDecision: () => () => {},
	decideStop: mocked.decision,
}));
afterEach(() => {
	mocked.decision.mockReset();
});

function setup(code = 'SOURCE_UNAVAILABLE', retryable = true) {
	mocked.current = {
		session: {
			can: { stop: true },
			stop: {
				id: 'attempt',
				outcome: 'retained',
				runtime_state: 'running',
				failure: { code, retryable },
			},
			last_durable_capture: { at: '2026-01-01T00:00:00Z', version_id: 'v' },
		} as Session,
	};
	render(<SessionStopDialog />);
	return setupUser();
}

describe('stop failure dialog', () => {
	it('requires a separate destructive confirmation before force', async () => {
		const user = setup();
		await user.click(screen.getByRole('button', { name: 'Force stop…' }));
		expect(mocked.decision).not.toHaveBeenCalled();
		expect(screen.getByText(/permanently lost/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Force stop and discard changes' }));
		expect(mocked.decision).toHaveBeenCalledWith('force');
	});

	it('keeps the runtime without another stop request', async () => {
		const user = setup();
		await user.click(screen.getByRole('button', { name: 'Keep running' }));
		expect(mocked.decision).toHaveBeenCalledWith('keep');
	});

	it('allows deliberate retry after repairing a missing source', async () => {
		const user = setup('SOURCE_MISSING', false);
		expect(screen.getByText(/Restore it in the session/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry save' }));
		expect(mocked.decision).toHaveBeenCalledWith('retry');
	});
	it('allows retry after replacing a non-regular artifact with a regular file', async () => {
		const user = setup('ARTIFACT_INVALID', false);
		expect(screen.getByText(/not a regular file/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry save' }));
		expect(mocked.decision).toHaveBeenCalledWith('retry');
	});
});
