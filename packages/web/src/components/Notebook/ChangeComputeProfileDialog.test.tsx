import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ChangeComputeProfileDialog } from './ChangeComputeProfileDialog';

const json = (data: unknown) =>
	new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});

function makeFetch(
	currentComputeProfile?: string,
	modeDefaults = false,
	appComputeProfile?: string,
) {
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
				...(modeDefaults
					? {
							app_compute_profiles: [
								{ name: 'app-small', cpu: 1 },
								{ name: 'app-large', cpu: 4 },
							],
						}
					: {}),
			});
		}
		if (method === 'GET' && url === '/api/v1/projects/proj-x/notebooks/nb-1') {
			return json({
				meta: {
					id: 'nb-1',
					title: 'My NB',
					app_compute_profile: appComputeProfile,
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
	options: { restartLabel?: string; onRestart?: () => void; onAppRestart?: () => void } = {},
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
	function Harness() {
		const [isOpen, setIsOpen] = useState(true);
		return (
			<ChangeComputeProfileDialog
				isOpen={isOpen}
				onClose={() => {
					onClose();
					setIsOpen(false);
				}}
				projectId="proj-x"
				notebook={{ id: 'nb-1', title: 'My NB' }}
				restartActions={{
					edit: options.onRestart
						? { label: options.restartLabel ?? 'Restart session', onRestart: options.onRestart }
						: undefined,
					app: options.onAppRestart
						? { label: 'Restart app', onRestart: options.onAppRestart }
						: undefined,
				}}
			/>
		);
	}
	render(<Harness />, { wrapper });
	return { onClose };
}

const editing = () => within(screen.getByRole('radiogroup', { name: 'Editing profile' }));

const patchCall = (fetchImpl: ReturnType<typeof makeFetch>) =>
	fetchImpl.mock.calls.find(([, init]) => init?.method === 'PATCH');

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ChangeComputeProfileDialog', () => {
	it('shows different defaults and saves only the changed app choice', async () => {
		const user = userEvent.setup();
		const fetchImpl = makeFetch(undefined, true);
		renderDialog(fetchImpl);
		await waitFor(() =>
			expect(editing().getByRole('radio', { name: /Default \(small\)/ })).toBeChecked(),
		);
		const app = within(screen.getByRole('radiogroup', { name: 'App profile' }));
		expect(app.getByRole('radio', { name: /Default \(app-small\)/ })).toBeChecked();
		await user.click(app.getByRole('radio', { name: /^app-large/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(patchCall(fetchImpl)).toBeDefined());
		expect(JSON.parse(patchCall(fetchImpl)![1]!.body as string)).toEqual({
			app_compute_profile: 'app-large',
		});
	});

	it('can override an inherited editing profile with the first shared profile', async () => {
		const user = userEvent.setup();
		const fetchImpl = makeFetch('large');
		renderDialog(fetchImpl);
		await waitFor(() => expect(editing().getByRole('radio', { name: /^large/ })).toBeChecked());
		const app = within(screen.getByRole('radiogroup', { name: 'App profile' }));
		expect(app.getByRole('radio', { name: 'Use editing profile' })).toBeChecked();
		await user.click(app.getByRole('radio', { name: /^small/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(patchCall(fetchImpl)).toBeDefined());
		expect(JSON.parse(patchCall(fetchImpl)![1]!.body as string)).toEqual({
			app_compute_profile: 'small',
		});
	});

	it.each([
		{ modeDefaults: false, appOverride: undefined, shouldRestart: true },
		{ modeDefaults: true, appOverride: undefined, shouldRestart: false },
		{ modeDefaults: false, appOverride: 'small', shouldRestart: false },
	])(
		'offers app restart only when editing changes its effective profile: %j',
		async ({ modeDefaults, appOverride, shouldRestart }) => {
			const user = userEvent.setup();
			const onAppRestart = vi.fn();
			const { onClose } = renderDialog(makeFetch(undefined, modeDefaults, appOverride), {
				onAppRestart,
			});
			await waitFor(() =>
				expect(editing().getByRole('radio', { name: /Default \(small\)/ })).toBeChecked(),
			);
			await user.click(editing().getByRole('radio', { name: /^large/ }));
			await user.click(screen.getByRole('button', { name: 'Save' }));
			await waitFor(() => expect(onClose).toHaveBeenCalled());
			if (shouldRestart) {
				await user.click(await screen.findByRole('button', { name: 'Restart app' }));
				expect(onAppRestart).toHaveBeenCalledOnce();
			} else {
				expect(screen.queryByRole('button', { name: 'Restart app' })).not.toBeInTheDocument();
			}
		},
	);

	it('lists Default first with derived resources and seeds the stored choice', async () => {
		renderDialog(makeFetch('large'));

		await waitFor(() => expect(editing().getByRole('radio', { name: /large/ })).toBeChecked());
		expect(editing().getByRole('radio', { name: /Default \(small\)/ })).not.toBeChecked();
		expect(editing().getByText('1 CPU · 2 Gi')).toBeInTheDocument();
		expect(editing().getByText('8 CPU · 32 Gi')).toBeInTheDocument();
	});

	it('keeps a removed stored profile visible but disabled', async () => {
		const user = userEvent.setup();
		renderDialog(makeFetch('gpu-big'));

		await screen.findByRole('radiogroup', { name: 'Editing profile' });
		const stale = await editing().findByRole('radio', { name: /gpu-big \(unavailable\)/ });
		expect(stale).toBeChecked();
		expect(stale).toBeDisabled();
		expect(screen.getByText(/removed by your operator/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		await user.click(editing().getByRole('radio', { name: /Default \(small\)/ }));
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('PATCHes null for Default and offers restart from the confirmation toast', async () => {
		const user = userEvent.setup();
		const fetchImpl = makeFetch('large');
		const onRestart = vi.fn();
		const { onClose } = renderDialog(fetchImpl, { onRestart });

		await waitFor(() => expect(editing().getByRole('radio', { name: /large/ })).toBeChecked());
		await user.click(editing().getByRole('radio', { name: /Default \(small\)/ }));
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const call = patchCall(fetchImpl);
		expect(JSON.parse(call![1]!.body as string)).toEqual({ compute_profile: null });
		expect(onClose).toHaveBeenCalled();
		await user.click(await screen.findByRole('button', { name: 'Restart session' }));
		expect(onRestart).toHaveBeenCalled();
	});
});
