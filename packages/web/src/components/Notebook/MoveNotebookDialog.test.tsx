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

function renderDialog() {
	return renderWithClient(
		<MoveNotebookDialog isOpen onClose={vi.fn()} projectId="proj-source" notebook={notebook} />,
		{ route: '/projects/proj-source' },
	);
}

afterEach(() => {
	sessionStorage.clear();
	vi.unstubAllGlobals();
});

describe('MoveNotebookDialog', () => {
	it('allows a different destination and uses a new key after a rejected preflight', async () => {
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
			expect(pendingNotebookMoves('proj-source')).toEqual([]);
		});
		await user.click(screen.getByRole('radio', { name: 'Second destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(JSON.parse(requests[1].body)).toEqual({ destination_project_id: 'proj-b' });
		expect(requests[1].headers.get('idempotency-key')).not.toBe(
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
		const requests: Headers[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/move')) {
					requests.push(new Headers(init?.headers));
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
		expect(requests[0].get('idempotency-key')).toBeTruthy();
		expect(requests[1].get('idempotency-key')).toBe(requests[0].get('idempotency-key'));
		expect(requests[0].get('if-match')).toBe(`"${notebook.updated_at}"`);
	});
});
