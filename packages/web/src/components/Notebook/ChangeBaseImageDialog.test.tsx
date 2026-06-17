import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ChangeBaseImageDialog } from './ChangeBaseImageDialog';

const json = (data: unknown) =>
	new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});

/** Routes the capabilities + notebook-detail GETs; records the PATCH. */
function makeFetch(currentBaseImage?: string) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (url === '/api/v1/capabilities') {
			return json({ sandbox_images: ['img-a', 'img-b', 'img-c'] });
		}
		if (method === 'GET' && url === '/api/v1/projects/proj-x/notebooks/nb-1') {
			return json({
				meta: { id: 'nb-1', title: 'My NB', base_image: currentBaseImage },
				readme: null,
				source: { type: 'local', current_version_id: 'ver-1' },
			});
		}
		if (method === 'PATCH') {
			return json({ id: 'nb-1', title: 'My NB' });
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
}

function renderDialog(fetchImpl: ReturnType<typeof makeFetch>) {
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
		<ChangeBaseImageDialog
			isOpen
			onClose={onClose}
			projectId="proj-x"
			notebook={{ id: 'nb-1', title: 'My NB' }}
		/>,
		{ wrapper },
	);
	return { onClose };
}

const patchCall = (fetchImpl: ReturnType<typeof makeFetch>) =>
	fetchImpl.mock.calls.find(([, init]) => init?.method === 'PATCH');

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ChangeBaseImageDialog', () => {
	it('lists Default plus every configured image and seeds the stored choice', async () => {
		renderDialog(makeFetch('img-b'));

		await waitFor(() => expect(screen.getByRole('radio', { name: 'img-b' })).toBeChecked());
		expect(screen.getByRole('radio', { name: /Default/ })).not.toBeChecked();
		expect(screen.getByRole('radio', { name: 'img-a' })).toBeInTheDocument();
		expect(screen.getByRole('radio', { name: 'img-c' })).toBeInTheDocument();
	});

	it('seeds Default when the notebook stores no choice', async () => {
		renderDialog(makeFetch(undefined));
		await waitFor(() => expect(screen.getByRole('radio', { name: /Default/ })).toBeChecked());
	});

	it('PATCHes a chosen image and closes on success', async () => {
		const user = userEvent.setup();
		const fetchImpl = makeFetch(undefined);
		const { onClose } = renderDialog(fetchImpl);

		// Wait for capabilities AND the detail seed to settle, so the seed can't
		// reset the selection after the click.
		await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
		await user.click(await screen.findByRole('radio', { name: 'img-c' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const call = patchCall(fetchImpl);
		expect(call).toBeDefined();
		expect(String(call![0])).toBe('/api/v1/projects/proj-x/notebooks/nb-1');
		expect(JSON.parse(call![1]!.body as string)).toEqual({ base_image: 'img-c' });
		expect(onClose).toHaveBeenCalled();
	});

	it('keeps Save disabled when the detail fetch fails (never silently clears the choice)', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/v1/capabilities') {
				return json({ sandbox_images: ['img-a', 'img-b', 'img-c'] });
			}
			if ((init?.method ?? 'GET') === 'GET') {
				return new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL' } }), {
					status: 500,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`unexpected fetch: ${init?.method} ${url}`);
		});
		renderDialog(fetchImpl as ReturnType<typeof makeFetch>);

		await screen.findByRole('radio', { name: /Default/ });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
		expect(patchCall(fetchImpl as ReturnType<typeof makeFetch>)).toBeUndefined();
	});

	it('PATCHes base_image: null when reset to Default', async () => {
		const user = userEvent.setup();
		const fetchImpl = makeFetch('img-b');
		const { onClose } = renderDialog(fetchImpl);

		// Wait for the stored choice to seed before switching to Default.
		await waitFor(() => expect(screen.getByRole('radio', { name: 'img-b' })).toBeChecked());
		await user.click(screen.getByRole('radio', { name: /Default/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const call = patchCall(fetchImpl);
		expect(JSON.parse(call![1]!.body as string)).toEqual({ base_image: null });
		expect(onClose).toHaveBeenCalled();
	});
});
