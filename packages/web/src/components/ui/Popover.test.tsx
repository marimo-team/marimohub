import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popover } from './Popover';

describe('Popover', () => {
	it('renders plain children when opened', async () => {
		const user = userEvent.setup();
		render(
			<Popover label="Info" trigger={<span>i</span>}>
				<p>Plain body</p>
			</Popover>,
		);

		expect(screen.queryByText('Plain body')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Info' }));
		expect(await screen.findByText('Plain body')).toBeInTheDocument();
	});

	// Pins the render-prop contract: react-aria's Dialog invokes function
	// children with a working `close` — the Footer's settings shortcut relies
	// on it to dismiss the popover on in-app navigation.
	it('invokes function children with a working close handler', async () => {
		const user = userEvent.setup();
		render(
			<Popover label="Info" trigger={<span>i</span>}>
				{({ close }) => (
					<button type="button" onClick={close}>
						Close me
					</button>
				)}
			</Popover>,
		);

		await user.click(screen.getByRole('button', { name: 'Info' }));
		await user.click(await screen.findByRole('button', { name: 'Close me' }));
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Close me' })).not.toBeInTheDocument(),
		);
	});
});
