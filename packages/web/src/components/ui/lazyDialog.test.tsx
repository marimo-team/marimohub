import { afterEach, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { lazyDialog } from './lazyDialog';

afterEach(() => vi.restoreAllMocks());

it('loads only on first open and stays mounted for close animations', async () => {
	const unmounted = vi.fn();
	const load = vi.fn(async () => ({
		default: function Dialog({ isOpen }: { isOpen: boolean; onClose: () => void }) {
			useEffect(() => unmounted, []);
			return <output>{isOpen ? 'Open' : 'Closed'}</output>;
		},
	}));
	const Dialog = lazyDialog(load);
	const { rerender, unmount } = render(<Dialog isOpen={false} onClose={() => {}} />);
	expect(load).not.toHaveBeenCalled();
	rerender(<Dialog isOpen onClose={() => {}} />);
	await screen.findByText('Open');
	rerender(<Dialog isOpen={false} onClose={() => {}} />);
	expect(screen.getByText('Closed')).toBeVisible();
	expect(unmounted).not.toHaveBeenCalled();
	rerender(<Dialog isOpen onClose={() => {}} />);
	expect(load).toHaveBeenCalledTimes(1);
	unmount();
	expect(unmounted).toHaveBeenCalledTimes(1);
});

it('closes a failed dialog without replacing the shell and retries on reopen', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const errorToast = vi.spyOn(toast, 'error');
	const chunkError = new TypeError('Failed to fetch dynamically imported module');
	const load = vi
		.fn()
		.mockRejectedValueOnce(chunkError)
		.mockResolvedValue({
			default: ({ isOpen }: { isOpen: boolean; onClose: () => void }) =>
				isOpen ? <p>Recovered dialog</p> : null,
		});
	const Dialog = lazyDialog(load);
	function Shell() {
		const [isOpen, setOpen] = useState(false);
		return (
			<>
				<p>Workspace intact</p>
				<button onClick={() => setOpen(true)}>Open dialog</button>
				<output>{isOpen ? 'opening' : 'closed'}</output>
				<Dialog isOpen={isOpen} onClose={() => setOpen(false)} />
			</>
		);
	}
	render(<Shell />);
	fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
	await waitFor(() => expect(screen.getByText('closed')).toBeVisible());
	expect(screen.getByText('Workspace intact')).toBeVisible();
	expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
	expect(errorToast).toHaveBeenCalledWith(
		'Unable to open dialog.',
		expect.objectContaining({ action: expect.objectContaining({ label: 'Reload page' }) }),
	);
	fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
	await screen.findByText('Recovered dialog');
	expect(load).toHaveBeenCalledTimes(2);
});
