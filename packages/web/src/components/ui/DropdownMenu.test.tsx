import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from './DropdownMenu';

function setup(onAction = vi.fn()) {
	render(
		<DropdownMenu
			label="Notebook actions"
			icon={<MoreHorizontal />}
			options={[
				{ id: 'download-file', label: 'Download notebook file' },
				{ id: 'delete', label: 'Delete', danger: true, separatorBefore: true },
			]}
			onAction={onAction}
		/>,
	);
	return { onAction };
}

describe('DropdownMenu', () => {
	it('keeps the menu closed until the trigger is pressed', () => {
		setup();
		expect(screen.getByRole('button', { name: 'Notebook actions' })).toBeInTheDocument();
		expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
	});

	it('opens the menu and fires onAction with the chosen item id', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Download notebook file' }));

		expect(onAction).toHaveBeenCalledTimes(1);
		expect(onAction).toHaveBeenCalledWith('download-file');
	});

	it('renders separators before grouped options', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: 'Notebook actions' }));

		expect(screen.getByRole('separator')).toBeInTheDocument();
	});
});
