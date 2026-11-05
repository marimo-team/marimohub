import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithClient, jsonOk, jsonError } from '@/test/render';
import { MoveNotebookDialog } from './MoveNotebookDialog';

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
	vi.unstubAllGlobals();
});

describe('MoveNotebookDialog', () => {
	it('moves to the chosen managed project with the notebook version as precondition', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const requests: { headers: Headers; body: unknown }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith('/move')) {
					requests.push({
						headers: new Headers(init?.headers),
						body: JSON.parse(String(init?.body)),
					});
					return jsonOk({ ...notebook, project_id: 'proj-destination' });
				}
				expect(url).toContain('managed_only=true');
				return jsonOk({
					items: [{ id: 'proj-destination', name: 'Destination', status: 'active' }],
					next_cursor: null,
				});
			}),
		);
		renderDialog(onClose);
		await user.click(await screen.findByRole('radio', { name: 'Destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(requests.map((request) => request.body)).toEqual([
			{ destination_project_id: 'proj-destination' },
		]);
		expect(requests[0].headers.get('if-match')).toBe(`"${notebook.updated_at}"`);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('shows the server error and lets the user retry the same destination', async () => {
		const user = userEvent.setup();
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes('/move')) {
					calls++;
					return jsonError('CONFLICT', 'Stop notebook sessions before moving', 409);
				}
				return jsonOk({
					items: [{ id: 'proj-a', name: 'First destination', status: 'active' }],
					next_cursor: null,
				});
			}),
		);
		renderDialog();
		await user.click(await screen.findByRole('radio', { name: 'First destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Stop notebook sessions');
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		await waitFor(() => expect(calls).toBe(2));
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
	});
});
