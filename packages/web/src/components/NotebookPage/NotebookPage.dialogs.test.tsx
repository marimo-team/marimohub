import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { setupUser } from '@/test/render';
import { toast } from 'sonner';
import { makeFetch, renderPage } from './NotebookPage.testWorld';

// Vitest wraps errors thrown by a mock factory, so throw from the export read to reach lazyDialog unwrapped.
vi.mock('@/components/Notebook/RenameNotebookDialog', () => ({
	get RenameNotebookDialog() {
		throw new TypeError('Failed to fetch dynamically imported module');
	},
}));

afterEach(() => vi.restoreAllMocks());

it('keeps the kernel iframe mounted when a dialog chunk fails to load', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const errorToast = vi.spyOn(toast, 'error');
	const user = setupUser();
	makeFetch({ role: 'editor' });
	renderPage();
	const iframe = await screen.findByTitle('Forecast');
	await user.click(screen.getByRole('button', { name: 'Forecast — notebook menu' }));
	await user.click(screen.getByRole('menuitem', { name: 'Rename notebook…' }));
	await waitFor(() =>
		expect(errorToast).toHaveBeenCalledWith(
			'Unable to open dialog.',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Reload page' }) }),
		),
	);
	expect(screen.getByTitle('Forecast')).toBe(iframe);
	expect(screen.queryByRole('dialog', { name: 'Rename Notebook' })).not.toBeInTheDocument();
});
