import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMatchMedia, renderWithClient } from '@/test/render';
import { ConversationSidebar } from './ConversationSidebar';

function setup({
	mobile = false,
	loading = false,
	error = undefined as string | undefined,
	busy = false,
	empty = false,
} = {}) {
	installMatchMedia(mobile);
	const onClose = vi.fn();
	const onSelect = vi.fn();
	const onRetry = vi.fn();
	renderWithClient(
		<ConversationSidebar
			open
			onClose={onClose}
			onSelect={onSelect}
			onDelete={vi.fn()}
			onRetry={onRetry}
			loading={loading}
			error={error}
			busy={busy}
			selected="first"
			items={
				empty
					? []
					: [
							{
								schema_version: 1,
								id: 'first',
								title: 'Revenue report',
								message_count: 2,
								created_at: '2026-11-03T12:00:00Z',
								updated_at: '2026-11-03T12:00:00Z',
							},
						]
			}
		/>,
	);
	return { user: userEvent.setup(), onClose, onSelect, onRetry };
}

describe('ConversationSidebar', () => {
	it('stays open when selecting a chat on desktop', async () => {
		const { user, onSelect, onClose } = setup();
		expect(screen.getByRole('complementary', { name: 'Your conversations' })).toBeVisible();
		const selected = screen.getByRole('button', { name: /^Revenue report/ });
		expect(selected).toHaveAttribute('aria-current', 'page');
		await user.click(selected);
		expect(onSelect).toHaveBeenCalledWith('first');
		expect(onClose).not.toHaveBeenCalled();
		await user.click(screen.getByRole('button', { name: 'Collapse history' }));
		expect(onClose).toHaveBeenCalledOnce();
	});
	it('closes the mobile drawer after selection', async () => {
		const { user, onSelect, onClose } = setup({ mobile: true });
		expect(screen.getByRole('dialog', { name: 'Your conversations' })).toBeVisible();
		await user.click(screen.getByRole('button', { name: /^Revenue report/ }));
		expect(onSelect).toHaveBeenCalledWith('first');
		expect(onClose).toHaveBeenCalledOnce();
	});
	it('dismisses the mobile drawer with Escape', async () => {
		const { user, onClose } = setup({ mobile: true });
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledOnce();
	});
	it('blocks switching and deletion while a turn is active', () => {
		setup({ busy: true });
		expect(screen.getByRole('button', { name: /^Revenue report/ })).toBeDisabled();
		expect(
			screen.getByRole('button', { name: 'Delete conversation Revenue report' }),
		).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Start a new chat' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Collapse history' })).toBeEnabled();
	});
	it('distinguishes loading from an empty history', () => {
		setup({ loading: true, empty: true });
		expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
		expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
	});
	it('offers retry for a failed history request', async () => {
		const { user, onRetry } = setup({ error: 'History unavailable', empty: true });
		expect(screen.getByRole('alert')).toHaveTextContent('History unavailable');
		expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry history' }));
		expect(onRetry).toHaveBeenCalledOnce();
	});
	it('allows starting a chat from an empty history', async () => {
		const { user, onSelect } = setup({ empty: true });
		expect(screen.getByText('No conversations yet.')).toBeVisible();
		await user.click(screen.getByRole('button', { name: 'Start a new chat' }));
		expect(onSelect).toHaveBeenCalledWith(null);
	});
});
