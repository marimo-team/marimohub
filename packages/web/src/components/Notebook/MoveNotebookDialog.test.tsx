import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithClient, jsonOk, jsonError } from '@/test/render';
import { MoveNotebookDialog } from './MoveNotebookDialog';
import { pendingNotebookMoves } from './pendingMoves';

const notebook = {
	id: 'nb-1',
	title: 'Forecast',
	updated_at: '2026-11-04T12:00:00Z',
	source_type: 'git',
};

function renderDialog(onClose = vi.fn()) {
	return renderWithClient(
		<MoveNotebookDialog isOpen onClose={onClose} projectId="proj-source" notebook={notebook} />,
		{ route: '/projects/proj-source' },
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	sessionStorage.clear();
	vi.unstubAllGlobals();
});

describe('MoveNotebookDialog', () => {
	it.each([
		{ failureAt: 1, name: 'SecurityError' },
		{ failureAt: 2, name: 'QuotaExceededError' },
	])(
		'completes the move when storage write $failureAt throws $name',
		async ({ failureAt, name }) => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			const write = sessionStorage.setItem.bind(sessionStorage);
			let writes = 0;
			vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
				if (++writes === failureAt) throw new DOMException('Storage unavailable', name);
				write(key, value);
			});
			const fetch = vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith('/move')
					? jsonOk({ ...notebook, project_id: 'proj-destination' })
					: jsonOk({
							items: [{ id: 'proj-destination', name: 'Destination', status: 'active' }],
							next_cursor: null,
						}),
			);
			vi.stubGlobal('fetch', fetch);
			renderDialog(onClose);
			await user.click(await screen.findByRole('radio', { name: 'Destination' }));
			await user.click(screen.getByRole('button', { name: /^Move$/ }));
			await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
			expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/move'))).toHaveLength(1);
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		},
	);

	it('retains the request after a conflict even while the source is readable', async () => {
		const user = userEvent.setup();
		const requests: { headers: Headers; body: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/move')) {
					requests.push({ headers: new Headers(init?.headers), body: String(init?.body) });
					return jsonError('CONFLICT', 'Stop notebook sessions before moving', 409);
				}
				if (url.includes('/notebooks/nb-1')) return jsonOk({ meta: notebook });
				return jsonOk({
					items: [
						{ id: 'proj-a', name: 'First destination', status: 'active' },
						{ id: 'proj-b', name: 'Second destination', status: 'active' },
					],
					next_cursor: null,
				});
			}),
		);
		renderDialog();
		await user.click(await screen.findByRole('radio', { name: 'First destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => {
			expect(requests).toHaveLength(1);
			expect(pendingNotebookMoves('proj-source')).toHaveLength(1);
		});
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Retry this move to the same destination',
		);
		expect(screen.getByRole('radio', { name: 'Second destination' })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(JSON.parse(requests[1].body)).toEqual({ destination_project_id: 'proj-a' });
		expect(requests[1].headers.get('idempotency-key')).toBe(
			requests[0].headers.get('idempotency-key'),
		);
	});

	it('disables moves when no other managed projects are available', async () => {
		const fetch = vi.fn(async () =>
			jsonOk({
				items: [
					{ id: 'proj-source', name: 'Source', status: 'active' },
					{ id: 'proj-deleted', name: 'Deleted', status: 'deleted' },
				],
				next_cursor: null,
			}),
		);
		vi.stubGlobal('fetch', fetch);
		renderDialog();
		await screen.findByText(/No other projects are available/);
		expect(screen.getByRole('button', { name: /^Move$/ })).toBeDisabled();
		expect(screen.queryByRole('radio')).not.toBeInTheDocument();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(pendingNotebookMoves('proj-source')).toEqual([]);
	});

	it('keeps the same destination and request key when retrying after a reload', async () => {
		const user = userEvent.setup();
		const requests: { headers: Headers; body: unknown }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/move')) {
					requests.push({
						headers: new Headers(init?.headers),
						body: JSON.parse(String(init?.body)),
					});
					return jsonError('INTERNAL_ERROR', 'Copy interrupted');
				}
				expect(url).toContain('managed_only=true');
				return jsonOk({
					items: [{ id: 'proj-destination', name: 'Destination', status: 'active' }],
					next_cursor: null,
				});
			}),
		);
		const first = renderDialog();
		await user.click(await screen.findByRole('radio', { name: 'Destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(await screen.findByRole('alert')).toHaveTextContent('Copy interrupted');
		expect(pendingNotebookMoves('proj-source')).toHaveLength(1);
		first.unmount();
		renderDialog();
		await screen.findByRole('radio', { name: 'Destination' });
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[0].headers.get('idempotency-key')).toBeTruthy();
		expect(requests[1].headers.get('idempotency-key')).toBe(
			requests[0].headers.get('idempotency-key'),
		);
		expect(requests[0].headers.get('if-match')).toBe(`"${notebook.updated_at}"`);
		expect(requests.map((request) => request.body)).toEqual([
			{ destination_project_id: 'proj-destination' },
			{ destination_project_id: 'proj-destination' },
		]);
	});
});
