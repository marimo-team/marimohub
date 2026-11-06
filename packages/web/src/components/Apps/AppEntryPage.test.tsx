import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@/context/ThemeContext';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { makeFetch, NID, PID, sessionPosts } from '../NotebookPage/NotebookPage.testWorld';
import { AppEntryPage } from './AppEntryPage';

function setup(appError: { code: string; message: string; status: number }) {
	const existing = makeFetch({ role: 'manager' });
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith(`/notebooks/${NID}/app`))
				return jsonError(appError.code, appError.message, appError.status);
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
	vi.unstubAllGlobals();
});

describe('AppEntryPage', () => {
	it('explains a pending move instead of opening the notebook', async () => {
		const existing = setup({
			code: 'MOVE_IN_PROGRESS',
			message: `Notebook ${NID} is being moved`,
			status: 409,
		});
		expect(await screen.findByText('This notebook is being moved')).toBeInTheDocument();
		expect(await screen.findByText(/It is moving to proj-dest\./)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
			'href',
			`/projects/${PID}`,
		);
		expect(sessionPosts(existing)).toHaveLength(0);
	});

	it('keeps the not-found path for a missing notebook', async () => {
		setup({ code: 'NOT_FOUND', message: 'Notebook not found', status: 404 });
		expect(await screen.findByRole('button', { name: /^Session Running/ })).toBeInTheDocument();
		expect(screen.queryByText('This notebook is being moved')).not.toBeInTheDocument();
		const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
		expect(urls.some((url) => url.endsWith('/move'))).toBe(false);
	});
});
