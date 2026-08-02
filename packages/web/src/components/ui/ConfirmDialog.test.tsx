import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

function setup(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
	const onConfirm = vi.fn();
	const onClose = vi.fn();
	render(
		<ConfirmDialog
			isOpen
			onClose={onClose}
			title="Delete Notebook"
			description='Are you sure you want to delete "Analysis"?'
			confirmLabel="Delete"
			onConfirm={onConfirm}
			{...overrides}
		/>,
	);
	return { onConfirm, onClose };
}

describe('ConfirmDialog', () => {
	it('renders the title and description when open', () => {
		setup();
		expect(screen.getByRole('heading', { name: 'Delete Notebook' })).toBeInTheDocument();
		expect(screen.getByText('Are you sure you want to delete "Analysis"?')).toBeInTheDocument();
	});

	it('renders nothing when closed', () => {
		setup({ isOpen: false });
		expect(screen.queryByRole('heading', { name: 'Delete Notebook' })).not.toBeInTheDocument();
	});

	it('fires onConfirm when the confirm button is pressed', async () => {
		const user = userEvent.setup();
		const { onConfirm } = setup();
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('fires onClose when Cancel is pressed', async () => {
		const user = userEvent.setup();
		const { onClose } = setup();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('confirms when Enter is pressed (the dialog is a real form)', async () => {
		const user = userEvent.setup();
		const { onConfirm } = setup();
		// No type-to-confirm field → the confirm button is focused on open, so Enter
		// activates it.
		await user.keyboard('{Enter}');
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('does not confirm on Enter while the confirm guard is active', async () => {
		const user = userEvent.setup();
		const { onConfirm } = setup({
			confirmDisabled: true,
			children: <input aria-label="confirm-name" />,
		});
		await user.click(screen.getByLabelText('confirm-name'));
		await user.keyboard('{Enter}');
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('shows the pending label and disables confirm while pending', () => {
		const { onConfirm } = setup({ isPending: true, pendingLabel: 'Deleting...' });
		const confirm = screen.getByRole('button', { name: 'Deleting...' });
		expect(confirm).toBeDisabled();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('does not close from the modal dismiss path while pending', async () => {
		const user = userEvent.setup();
		const { onClose } = setup({ isPending: true });

		await user.keyboard('{Escape}');

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});

	it('disables confirm when confirmDisabled is set (e.g. type-to-confirm guard)', () => {
		setup({ confirmDisabled: true });
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
	});

	it('renders extra children (e.g. a confirm field) between description and buttons', () => {
		setup({ children: <input aria-label="confirm-name" /> });
		expect(screen.getByLabelText('confirm-name')).toBeInTheDocument();
	});
});
