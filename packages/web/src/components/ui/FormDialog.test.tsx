import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormDialog } from './FormDialog';
import { TextField } from './TextField';

function setup(overrides: Partial<React.ComponentProps<typeof FormDialog>> = {}) {
	const onSubmit = vi.fn();
	const onClose = vi.fn();
	render(
		<FormDialog
			isOpen
			onClose={onClose}
			title="Create New Project"
			submitLabel="Create"
			onSubmit={onSubmit}
			{...overrides}
		>
			<TextField label="Project Name" value="" onChange={() => {}} />
		</FormDialog>,
	);
	return { onSubmit, onClose };
}

describe('FormDialog', () => {
	it('renders the title and field when open', () => {
		setup();
		expect(screen.getByRole('heading', { name: 'Create New Project' })).toBeInTheDocument();
		expect(screen.getByLabelText('Project Name')).toBeInTheDocument();
	});

	it('fires onSubmit when the submit button is pressed', async () => {
		const user = userEvent.setup();
		const { onSubmit } = setup();
		await user.click(screen.getByRole('button', { name: 'Create' }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('submits on Enter from within a field (native form submit)', async () => {
		const user = userEvent.setup();
		const { onSubmit } = setup();
		await user.type(screen.getByLabelText('Project Name'), 'Hello{Enter}');
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('fires onClose when Cancel is pressed', async () => {
		const user = userEvent.setup();
		const { onClose } = setup();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('shows the pending label and disables submit while pending', () => {
		setup({ isPending: true, pendingLabel: 'Creating...' });
		expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();
	});

	it('disables submit when submitDisabled is set', () => {
		setup({ submitDisabled: true });
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
	});

	it('uses a custom cancel label when provided', () => {
		setup({ cancelLabel: 'Discard' });
		expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
	});
});
