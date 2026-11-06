import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@/context/ThemeContext';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { makeFetch, NID, PID, sessionPosts } from '../NotebookPage/NotebookPage.testWorld';
import { AppEntryPage } from './AppEntryPage';

type AppError = { code: string; message: string; status: number };

function setup(appError: AppError | (() => AppError)) {
	const existing = makeFetch({ role: 'manager' });
	const nextError = typeof appError === 'function' ? appError : () => appError;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith(`/notebooks/${NID}/app`)) {
				const error = nextError();
				return jsonError(error.code, error.message, error.status);
			}
			if (url.endsWith(`/notebooks/${NID}/move`))
				return jsonOk({
					phase: 'copying',
					destination_project_id: 'proj-dest',
					lease_expires_at: null,
					updated_at: '2026-11-04T12:00:00Z',
				});
			return existing(input, init);
		}),
	);
	renderWithClient(
		<ThemeProvider>
			<Routes>
				<Route path="/projects/:pid/notebooks/:nid" element={<AppEntryPage variant="edit" />} />
			</Routes>
		</ThemeProvider>,
		{ route: `/projects/${PID}/notebooks/${NID}`, toaster: false },
	);
	return existing;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const moving: AppError = {
	code: 'MOVE_IN_PROGRESS',
	message: `Notebook ${NID} is being moved`,
	status: 409,
};

function appRequests() {
	return vi
		.mocked(fetch)
		.mock.calls.filter(([input]) => String(input).endsWith(`/notebooks/${NID}/app`));
}

describe('AppEntryPage', () => {
	it('explains a pending move instead of opening the notebook', async () => {
		const existing = setup(moving);
		expect(await screen.findByText('This notebook is being moved')).toBeInTheDocument();
		expect(await screen.findByRole('link', { name: 'proj-dest' })).toHaveAttribute(
			'href',
			'/projects/proj-dest',
		);
		expect(screen.getByText(/opens in its new project once the move finishes/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
			'href',
			`/projects/${PID}`,
		);
		expect(sessionPosts(existing)).toHaveLength(0);
	});

	it('re-checks the notebook while the notice shows and opens it once the move is cancelled', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		let cancelled = false;
		setup(() =>
			cancelled ? { code: 'NOT_FOUND', message: 'Notebook not found', status: 404 } : moving,
		);
		expect(await screen.findByText('This notebook is being moved')).toBeInTheDocument();
		expect(appRequests()).toHaveLength(1);
		cancelled = true;
		await act(() => vi.advanceTimersByTimeAsync(30_000));
		await waitFor(() =>
			expect(screen.queryByText('This notebook is being moved')).not.toBeInTheDocument(),
		);
		expect(appRequests()).toHaveLength(2);
	});

	it('keeps the not-found path for a missing notebook', async () => {
		setup({ code: 'NOT_FOUND', message: 'Notebook not found', status: 404 });
		expect(await screen.findByRole('button', { name: /^Session Running/ })).toBeInTheDocument();
		expect(screen.queryByText('This notebook is being moved')).not.toBeInTheDocument();
		const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
		expect(urls.some((url) => url.endsWith('/move'))).toBe(false);
	});
});
