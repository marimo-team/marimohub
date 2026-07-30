import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ChangeComputeProfileDialog } from './ChangeComputeProfileDialog';

const json = (data: unknown) =>
	new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});

function makeFetch(currentComputeProfile?: string) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (url === '/api/v1/capabilities') {
			return json({
				compute_profiles: [
					{ name: 'small', cpu: 1, memory_bytes: 2 * 1024 ** 3 },
					{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
				],
				compute_profile_override: 'editors',
			});
		}
		if (method === 'GET' && url === '/api/v1/projects/proj-x/notebooks/nb-1') {
			return json({
				meta: {
					id: 'nb-1',
					title: 'My NB',
					...(currentComputeProfile ? { compute_profile: currentComputeProfile } : {}),
				},
				readme: null,
				source: { type: 'local', current_version_id: 'ver-1' },
			});
		}
		if (method === 'PATCH') return json({ id: 'nb-1', title: 'My NB' });
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
}

function renderDialog(
	fetchImpl: ReturnType<typeof makeFetch>,
	options: { canRestart?: boolean; onRestart?: () => void } = {},
) {
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
		<ChangeComputeProfileDialog
			isOpen
			onClose={onClose}
			projectId="proj-x"
			notebook={{ id: 'nb-1', title: 'My NB' }}
			canRestart={options.canRestart}
			onRestart={options.onRestart}
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

describe('ChangeComputeProfileDialog', () => {
	it('lists Default first with derived resources and seeds the stored choice', async () => {
		renderDialog(makeFetch('large'));

		await waitFor(() => expect(screen.getByRole('radio', { name: /large/ })).toBeChecked());
		expect(screen.getByRole('radio', { name: /Default \(small\)/ })).not.toBeChecked();
		expect(screen.getByText('1 CPU · 2 Gi')).toBeInTheDocument();
		expect(screen.getByText('8 CPU · 32 Gi')).toBeInTheDocument();
	});

	it('keeps a removed stored profile visible but disabled', async () => {
		renderDialog(makeFetch('gpu-big'));

		const stale = await screen.findByRole('radio', { name: /gpu-big \(unavailable\)/ });
		expect(stale).toBeChecked();
		expect(stale).toBeDisabled();
		expect(screen.getByText(/removed by your operator/)).toBeInTheDocument();
	});

	it('PATCHes null for Default and offers restart from the confirmation toast', async () => {
		const user = userEvent.setup();
		const fetchImpl = makeFetch('large');
		const onRestart = vi.fn();
		const { onClose } = renderDialog(fetchImpl, { canRestart: true, onRestart });

		await waitFor(() => expect(screen.getByRole('radio', { name: /large/ })).toBeChecked());
		await user.click(screen.getByRole('radio', { name: /Default \(small\)/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const call = patchCall(fetchImpl);
		expect(JSON.parse(call![1]!.body as string)).toEqual({ compute_profile: null });
		expect(onClose).toHaveBeenCalled();
		const restart = (await screen.findByText('Restart session')).closest('button');
		expect(restart).not.toBeNull();
		restart!.click();
		expect(onRestart).toHaveBeenCalled();
	});
});
