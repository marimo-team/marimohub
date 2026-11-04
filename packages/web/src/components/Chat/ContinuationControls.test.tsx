import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationContinuation } from '@/api/conversations';
import { renderWithClient } from '@/test/render';
import { ContinuationControls } from './ContinuationControls';

function renderControls(continuation: ConversationContinuation) {
	const onResume = vi.fn(async () => true);
	const onDismiss = vi.fn(async () => {});
	renderWithClient(
		<ContinuationControls
			continuation={continuation}
			busy={false}
			onResume={onResume}
			onDismiss={onDismiss}
		/>,
	);
	return { onResume, onDismiss, user: userEvent.setup() };
}

describe('ContinuationControls', () => {
	it('continues or dismisses a paused task directly', async () => {
		const { onResume, onDismiss, user } = renderControls({
			status: 'paused',
			reason: 'stopped',
			task: 'Long task',
			observations: [],
			unresolved_calls: [],
		});
		expect(screen.getByText('Task paused')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Continue task' }));
		expect(onResume).toHaveBeenCalledExactlyOnceWith(false);
		await user.click(screen.getByRole('button', { name: 'Dismiss task' }));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('asks for a review of unresolved calls before continuing', async () => {
		const { onResume, user } = renderControls({
			status: 'needs_review',
			reason: 'interrupted',
			task: 'Create a notebook',
			observations: [],
			unresolved_calls: [{ id: 'c1', name: 'execute_code' }],
		});
		await user.click(screen.getByRole('button', { name: 'Review and continue' }));
		const dialog = await screen.findByRole('dialog', { name: 'Continue an interrupted task' });
		expect(within(dialog).getByRole('listitem')).toHaveTextContent('execute code');
		expect(onResume).not.toHaveBeenCalled();
		await user.click(
			within(dialog).getByRole('button', { name: 'I checked the outcome — continue' }),
		);
		expect(onResume).toHaveBeenCalledExactlyOnceWith(true);
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});
});
