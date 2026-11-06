import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderWithClient, jsonOk, jsonError } from '@/test/render';
import { MoveNotebookDialog } from './MoveNotebookDialog';

function projectList() {
	return jsonOk({
		items: [{ id: 'proj-destination', name: 'Destination', status: 'active' }],
		next_cursor: null,
	});
}

const notebook = {
	id: 'nb-1',
	title: 'Forecast',
	updated_at: '2026-11-04T12:00:00Z',
	source_type: 'git',
};

function renderDialog(
	onClose = vi.fn(),
	target: Parameters<typeof MoveNotebookDialog>[0]['notebook'] = notebook,
) {
	return renderWithClient(
		<MoveNotebookDialog isOpen onClose={onClose} projectId="proj-source" notebook={target} />,
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
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toContain('status=active');
			return jsonOk({
				items: [{ id: 'proj-source', name: 'Source', status: 'active' }],
				next_cursor: null,
			});
		});
		vi.stubGlobal('fetch', fetch);
		renderDialog();
		await screen.findByText(/No other projects are available/);
		expect(screen.getByRole('button', { name: /^Move$/ })).toBeDisabled();
		expect(screen.queryByRole('radio')).not.toBeInTheDocument();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('reports a failed destination listing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonError('INTERNAL_ERROR', 'boom', 500)),
		);
		renderDialog();
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Could not load destination projects.',
		);
		expect(screen.getByRole('button', { name: /^Move$/ })).toBeDisabled();
	});

	it('locks the form and dismissal while the move is pending', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		let finish!: (response: Response) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/move'))
					return new Promise<Response>((resolve) => {
						finish = resolve;
					});
				return projectList();
			}),
		);
		renderDialog(onClose);
		await user.click(await screen.findByRole('radio', { name: 'Destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		expect(await screen.findByRole('button', { name: 'Moving…' })).toBeDisabled();
		expect(screen.getByRole('radio', { name: 'Destination' })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await user.keyboard('{Escape}');
		expect(onClose).not.toHaveBeenCalled();
		finish(jsonError('CONFLICT', 'Move already running', 409));
		expect(await screen.findByRole('alert')).toHaveTextContent('Move already running');
	});

	it('navigates to the destination and confirms the move', async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith('/move')
					? jsonOk({ ...notebook, project_id: 'proj-destination' })
					: projectList(),
			),
		);
		renderWithClient(
			<Routes>
				<Route
					path="/projects/proj-source"
					element={
						<MoveNotebookDialog
							isOpen
							onClose={vi.fn()}
							projectId="proj-source"
							notebook={notebook}
						/>
					}
				/>
				<Route path="/projects/proj-destination" element={<p>Destination page</p>} />
			</Routes>,
			{ route: '/projects/proj-source' },
		);
		await user.click(await screen.findByRole('radio', { name: 'Destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		expect(await screen.findByText('Destination page')).toBeInTheDocument();
		expect(await screen.findByText('Moved "Forecast"')).toBeInTheDocument();
	});

	it.each([
		[403, 'FORBIDDEN', 'You need manager access in both projects'],
		[412, 'PRECONDITION_FAILED', 'Notebook changed. Start a new move.'],
	])('shows a %s error once, without the resume hint or cancel', async (status, code, message) => {
		const user = userEvent.setup();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith('/move') ? jsonError(code, message, status) : projectList(),
			),
		);
		renderDialog();
		await user.click(await screen.findByRole('radio', { name: 'Destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent(message);
		expect(alert).not.toHaveTextContent('An interrupted move resumes');
		expect(screen.getAllByText(message, { exact: false })).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Cancel move' })).not.toBeInTheDocument();
	});

	it('cancels a conflicting move and resets the dialog', async () => {
		const user = userEvent.setup();
		const moves: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith('/move')) {
					moves.push(init?.method ?? 'GET');
					return init?.method === 'DELETE'
						? jsonOk({ message: 'Move cancelled' })
						: jsonError('CONFLICT', 'Cancel the move to repair it', 409);
				}
				return projectList();
			}),
		);
		renderDialog();
		await user.click(await screen.findByRole('radio', { name: 'Destination' }));
		await user.click(screen.getByRole('button', { name: /^Move$/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent('An interrupted move resumes');
		await user.click(screen.getByRole('button', { name: 'Cancel move' }));
		expect(await screen.findByText('Cancelled the move of "Forecast"')).toBeInTheDocument();
		expect(moves).toEqual(['POST', 'DELETE']);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.getByRole('radio', { name: 'Destination' })).not.toBeChecked();
	});

	it('resumes a pending move to its stored destination', async () => {
		const user = userEvent.setup();
		const bodies: unknown[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith('/move')) {
					bodies.push(JSON.parse(String(init?.body)));
					return jsonOk({ ...notebook, project_id: 'proj-destination' });
				}
				return projectList();
			}),
		);
		renderDialog(vi.fn(), {
			...notebook,
			moving: { destination_project_id: 'proj-destination' },
		});
		expect(await screen.findByRole('radio', { name: 'Destination' })).toBeChecked();
		expect(screen.queryByRole('button', { name: /^Move$/ })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Resume move' }));
		await waitFor(() => expect(bodies).toEqual([{ destination_project_id: 'proj-destination' }]));
	});
});
