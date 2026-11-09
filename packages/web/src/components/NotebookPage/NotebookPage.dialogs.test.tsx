import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { makeFetch, renderPage } from './NotebookPage.testWorld';

vi.mock('@/components/Notebook/RenameNotebookDialog', () => {
	throw new TypeError('Failed to fetch dynamically imported module');
});

afterEach(() => vi.restoreAllMocks());

it('keeps the kernel iframe mounted when a dialog chunk fails to load', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const errorToast = vi.spyOn(toast, 'error');
	const user = userEvent.setup();
	makeFetch({ role: 'editor' });
	renderPage();
	const iframe = await screen.findByTitle('Forecast');
	await user.click(screen.getByRole('button', { name: 'Forecast — notebook menu' }));
	await user.click(screen.getByRole('menuitem', { name: 'Rename notebook…' }));
	await waitFor(() => expect(errorToast).toHaveBeenCalledWith('Unable to open dialog.', undefined));
	expect(screen.getByTitle('Forecast')).toBe(iframe);
	expect(screen.queryByRole('dialog', { name: 'Rename Notebook' })).not.toBeInTheDocument();
});
