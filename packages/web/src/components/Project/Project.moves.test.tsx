import { afterEach, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { savePendingNotebookMove } from '@/components/Notebook/pendingMoves';
import { Project } from './Project';
import { makeFetch, notebook, PID, project } from './Project.testWorld';

afterEach(() => sessionStorage.clear());

it('restores the correct pending move when navigating between projects', async () => {
	const user = userEvent.setup();
	makeFetch();
	const fallback = globalThis.fetch;
	const secondProject = 'proj-second';
	const secondNotebook = { ...notebook(), id: 'nb-second', title: 'Second notebook' };
	const requests: { url: string; key: string | null }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), 'http://localhost');
			if (url.pathname.endsWith('/move')) {
				requests.push({
					url: url.pathname,
					key: new Headers(init?.headers).get('idempotency-key'),
				});
				return jsonError('CONFLICT', 'Move already running', 409);
			}
			if (url.searchParams.get('managed_only'))
				return jsonOk({
					items: [{ ...project(), id: 'proj-destination', name: 'Destination' }],
					next_cursor: null,
				});
			if (url.pathname.endsWith(`/projects/${secondProject}`))
				return jsonOk({ ...project(), id: secondProject, name: 'Second project' });
			if (url.pathname.endsWith(`/projects/${secondProject}/notebooks`))
				return jsonOk({ items: [secondNotebook], next_cursor: null });
			return fallback(String(input).replace(secondProject, PID), init);
		}),
	);
	for (const [pid, target, key] of [
		[PID, notebook(), 'first-key'],
		[secondProject, secondNotebook, 'second-key'],
	] as const) {
		savePendingNotebookMove(pid, { notebook: target, destination: 'proj-destination', key });
	}
	const router = createMemoryRouter([{ path: '/projects/:pid', element: <Project /> }], {
		initialEntries: [`/projects/${PID}`],
	});
	renderWithClient(<RouterProvider router={router} />);
	await screen.findByText(/Move “Forecast” and its history/);

	await act(async () => {
		await router.navigate(`/projects/${secondProject}`);
	});
	await screen.findByText(/Move “Second notebook” and its history/);
	expect(screen.queryByText(/Move “Forecast” and its history/)).not.toBeInTheDocument();
	await user.click(screen.getByRole('button', { name: /^Move$/ }));
	await waitFor(() => expect(requests).toHaveLength(1));
	expect(requests[0]).toEqual({
		url: `/api/v1/projects/${secondProject}/notebooks/nb-second/move`,
		key: 'second-key',
	});

	await act(async () => {
		await router.navigate(`/projects/${PID}`);
	});
	await screen.findByText(/Move “Forecast” and its history/);
	await user.click(screen.getByRole('button', { name: /^Move$/ }));
	await waitFor(() => expect(requests).toHaveLength(2));
	expect(requests[1]).toEqual({
		url: `/api/v1/projects/${PID}/notebooks/nb-1/move`,
		key: 'first-key',
	});
});
