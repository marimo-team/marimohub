import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { onlineManager } from '@tanstack/react-query';
import { deepLinkKeys } from '@/api/deepLinks';
import { createTestQueryClient, jsonError, renderWithClient } from '@/test/render';
import { AppLinksDialog } from './AppLinksDialog';

const saved = { slug: 'sales', registration_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
const ok = (data: unknown) =>
	new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});

function setup(
	canManage = true,
	conflict = false,
	failures: { list?: boolean; release?: boolean } = {},
) {
	let links = [saved];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === 'POST') {
			if (conflict)
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'CONFLICT', message: 'This app slug is already registered' },
					}),
					{ status: 409, headers: { 'content-type': 'application/json' } },
				);
			const { slug } = JSON.parse(String(init.body)) as { slug: string };
			const link = { slug, registration_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
			links = [...links, link];
			return ok(link);
		}
		if (init?.method === 'DELETE') {
			if (failures.release) {
				failures.release = false;
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'Removal unavailable' },
					}),
					{ status: 503, headers: { 'content-type': 'application/json' } },
				);
			}
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				window.location.origin,
			);
			const slug = decodeURIComponent(url.pathname.split('/').at(-1)!);
			const registrationId = url.searchParams.get('registration_id');
			links = links.filter((link) => link.slug !== slug || link.registration_id !== registrationId);
			return ok(null);
		}
		if (failures.list) {
			failures.list = false;
			return new Response(
				JSON.stringify({
					success: false,
					error: { code: 'FORBIDDEN', message: 'Cannot load app links' },
				}),
				{ status: 403, headers: { 'content-type': 'application/json' } },
			);
		}
		return ok(links);
	});
	vi.stubGlobal('fetch', fetch);
	renderWithClient(
		<AppLinksDialog
			projectId="proj-1"
			notebookId="nb-1"
			canManage={canManage}
			onClose={() => {}}
		/>,
		{ toaster: true },
	);
	return fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AppLinksDialog', () => {
	it('lists aliases for readers without mutation controls', async () => {
		setup(false);
		expect(await screen.findByRole('link')).toHaveAttribute('href', '/app/sales');
		expect(screen.getByRole('button', { name: 'Copy sales' })).toBeInTheDocument();
		expect(screen.queryByRole('textbox', { name: 'App slug' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Remove sales' })).not.toBeInTheDocument();
	});

	it('normalizes input and shows a newly registered alias', async () => {
		const user = userEvent.setup();
		const fetch = setup();
		await user.type(screen.getByRole('textbox', { name: 'App slug' }), '  New-App  ');
		await user.click(screen.getByRole('button', { name: 'Create app link' }));
		expect(await screen.findByRole('button', { name: 'Copy new-app' })).toBeInTheDocument();
		expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe(
			JSON.stringify({ slug: 'new-app' }),
		);
	});

	it('shows global conflicts inline without also showing a toast', async () => {
		const user = userEvent.setup();
		const errorToast = vi.spyOn(toast, 'error');
		setup(true, true);
		await user.type(screen.getByRole('textbox', { name: 'App slug' }), 'taken');
		await user.click(screen.getByRole('button', { name: 'Create app link' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'This app slug is already registered',
		);
		expect(screen.getByRole('textbox', { name: 'App slug' })).toHaveValue('taken');
		expect(errorToast).not.toHaveBeenCalled();
	});

	it('includes the registration ID when removing a link and explains immediate reuse', async () => {
		const user = userEvent.setup();
		const fetch = setup();
		expect(screen.getByText(/Old shared URLs may then open another app/)).toBeInTheDocument();
		await user.click(await screen.findByRole('button', { name: 'Remove sales' }));
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Remove sales' })).not.toBeInTheDocument(),
		);
		const [url] = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')!;
		expect(String(url)).toContain(`/deep-links/sales?registration_id=${saved.registration_id}`);
	});
	it('shows a list failure and reloads aliases when retried', async () => {
		const user = userEvent.setup();
		setup(true, false, { list: true });
		expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load app links');
		expect(screen.queryByText('No app links yet.')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('button', { name: 'Copy sales' })).toBeInTheDocument();
	});

	it('keeps the alias after a failed removal and permits retry', async () => {
		const user = userEvent.setup();
		const fetch = setup(true, false, { release: true });
		await user.click(await screen.findByRole('button', { name: 'Remove sales' }));
		expect(await screen.findByText('Removal unavailable')).toBeInTheDocument();
		expect(screen.getByRole('link')).toHaveAttribute('href', '/app/sales');
		await user.click(screen.getByRole('button', { name: 'Remove sales' }));
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Remove sales' })).not.toBeInTheDocument(),
		);
		expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
	});
	it('clears a failed create message when the slug changes', async () => {
		const user = userEvent.setup();
		setup(true, true);
		await user.type(screen.getByRole('textbox', { name: 'App slug' }), 'taken');
		await user.click(screen.getByRole('button', { name: 'Create app link' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'This app slug is already registered',
		);
		await user.type(screen.getByRole('textbox', { name: 'App slug' }), '-new');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: 'App slug' })).toHaveValue('taken-new');
	});

	it('removes only the requested alias when a notebook has multiple links', async () => {
		const user = userEvent.setup();
		setup();
		await user.type(screen.getByRole('textbox', { name: 'App slug' }), 'revenue');
		await user.click(screen.getByRole('button', { name: 'Create app link' }));
		expect(await screen.findByRole('button', { name: 'Copy revenue' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Remove sales' }));
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Remove sales' })).not.toBeInTheDocument(),
		);
		expect(screen.getByRole('button', { name: 'Copy revenue' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Remove revenue' })).toBeInTheDocument();
	});

	it('hides cached aliases while offline and refreshes the list after reconnecting', async () => {
		const client = createTestQueryClient();
		client.setQueryData(deepLinkKeys.list('proj-1', 'nb-1'), [saved]);
		const fetch = vi.fn(async () => ok([]));
		vi.stubGlobal('fetch', fetch);
		onlineManager.setOnline(false);
		const view = renderWithClient(
			<AppLinksDialog projectId="proj-1" notebookId="nb-1" canManage onClose={() => {}} />,
			{ client, toaster: false },
		);
		try {
			expect(screen.queryByRole('button', { name: 'Copy sales' })).not.toBeInTheDocument();
			expect(screen.getByText('Loading links…')).toBeInTheDocument();
			expect(fetch).not.toHaveBeenCalled();
			onlineManager.setOnline(true);
			expect(await screen.findByText('No app links yet.')).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Copy sales' })).not.toBeInTheDocument();
		} finally {
			view.unmount();
			onlineManager.setOnline(true);
		}
	});

	it('does not show cached aliases when a fresh lookup fails', async () => {
		const client = createTestQueryClient();
		client.setQueryData(deepLinkKeys.list('proj-1', 'nb-1'), [saved]);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonError('FORBIDDEN', 'Cannot load app links', 403)),
		);
		renderWithClient(
			<AppLinksDialog projectId="proj-1" notebookId="nb-1" canManage onClose={() => {}} />,
			{ client, toaster: false },
		);
		expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load app links');
		expect(screen.queryByRole('button', { name: 'Copy sales' })).not.toBeInTheDocument();
		expect(screen.queryByText('No app links yet.')).not.toBeInTheDocument();
	});
});
