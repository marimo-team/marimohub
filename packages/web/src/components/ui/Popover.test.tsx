import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupUser } from '@/test/render';
import { Popover } from './Popover';

describe('Popover', () => {
	it('renders plain children when opened', async () => {
		const user = setupUser();
		render(
			<Popover label="Info" trigger={<span>i</span>}>
				<p>Plain body</p>
			</Popover>,
		);

		expect(screen.queryByText('Plain body')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Info' }));
		expect(await screen.findByText('Plain body')).toBeInTheDocument();
	});

	it('invokes function children with a working close handler', async () => {
		const user = setupUser();
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
