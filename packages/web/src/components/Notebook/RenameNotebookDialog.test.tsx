import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { RenameNotebookDialog } from './RenameNotebookDialog';

function renderDialog(fetchImpl = vi.fn()) {
	vi.stubGlobal('fetch', fetchImpl);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(
		<RenameNotebookDialog
			isOpen
			onClose={onClose}
			projectId="proj-x"
			notebook={{ id: 'nb-1', title: 'Old Name' }}
		/>,
		{ wrapper },
	);
	return { onClose };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('RenameNotebookDialog', () => {
	it('seeds the field with the current title', () => {
		renderDialog();
		expect(screen.getByLabelText('Notebook Name')).toHaveValue('Old Name');
	});

	it('PATCHes the new title and closes on success', async () => {
		const user = userEvent.setup();
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, _init: RequestInit) =>
				new Response(JSON.stringify({ success: true, data: { title: 'New Name' } }), {
					headers: { 'content-type': 'application/json' },
				}),
		);
		const { onClose } = renderDialog(fetchImpl);

		const field = screen.getByLabelText('Notebook Name');
		await user.clear(field);
		await user.type(field, 'New Name');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).toBe('/api/v1/projects/proj-x/notebooks/nb-1');
		expect(init).toMatchObject({ method: 'PATCH' });
		expect(JSON.parse(init.body as string)).toEqual({ title: 'New Name' });
		expect(onClose).toHaveBeenCalled();
	});

	it('disables Save when the title is blank', async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.clear(screen.getByLabelText('Notebook Name'));

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});
});
