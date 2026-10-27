import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { makeFetch, notebook, PID, renderProject } from './Project.testWorld';
import type { ProjectDetail } from '@/types';
import { projectKeys, systemKeys } from '@/api/queryKeys';
import { jsonError, jsonOk } from '@/test/render';

afterEach(() => localStorage.removeItem('notebook-view'));

const notebookPath = `/projects/${PID}/notebooks/nb-1`;

function interceptCapabilities(respond: () => Response | Promise<Response>) {
	const originalFetch = globalThis.fetch;
	vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith('/capabilities')) return respond();
		return originalFetch(input, init);
	});
}

function expectNavigation({ app = false, edit = false } = {}) {
	const row = within(screen.getByTestId('notebook-row'));
	expect(row.getByRole('link', { name: 'Forecast' })).toHaveAttribute(
		'href',
		app ? `${notebookPath}/app` : notebookPath,
	);
	if (edit) {
		const editLink = row.getByRole('link', { name: 'Edit Forecast' });
		expect(editLink).toBeVisible();
		expect(editLink).toHaveTextContent('Edit');
		expect(editLink).toHaveAttribute('href', notebookPath);
	} else {
		expect(row.queryByRole('link', { name: 'Edit Forecast' })).not.toBeInTheDocument();
	}
}

describe.each(['list', 'gallery'])('project notebook navigation in %s view', (view) => {
	beforeEach(() => localStorage.setItem('notebook-view', view));

	it.each<{
		target?: 'notebook' | 'app';
		role: ProjectDetail['your_role'];
		viewerModes?: string[];
		app: boolean;
		edit: boolean;
	}>([
		{ role: 'manager', app: false, edit: false },
		{ target: 'notebook', role: 'editor', viewerModes: ['app'], app: false, edit: false },
		{ target: 'app', role: 'admin', app: true, edit: true },
		{ target: 'app', role: 'manager', app: true, edit: true },
		{ target: 'app', role: 'editor', app: true, edit: true },
		{ target: 'app', role: 'viewer', viewerModes: ['app'], app: true, edit: false },
		{ target: 'app', role: 'viewer', viewerModes: ['app', 'edit'], app: true, edit: false },
		{ target: 'app', role: 'viewer', viewerModes: [], app: false, edit: false },
		{ target: 'app', role: 'viewer', app: false, edit: false },
	])('uses the permitted destination: %j', async ({ target, role, viewerModes, app, edit }) => {
		makeFetch({
			role,
			capabilities: { project_notebook_target: target, viewer_session_modes: viewerModes },
		});
		await renderProject();
		expectNavigation({ app, edit });
	});

	it('waits for capabilities before changing the destination to the app', async () => {
		makeFetch({ role: 'viewer' });
		let resolve!: (response: Response) => void;
		const pending = new Promise<Response>((done) => {
			resolve = done;
		});
		interceptCapabilities(() => pending);
		await renderProject();
		expectNavigation();

		await act(async () => {
			resolve(jsonOk({ project_notebook_target: 'app', viewer_session_modes: ['app'] }));
		});
		await waitFor(() => expectNavigation({ app: true }));
	});

	it.each(['http', 'network'])(
		'keeps notebook links after a %s capabilities failure and recovers on retry',
		async (failure) => {
			makeFetch();
			let fail = true;
			interceptCapabilities(async () => {
				if (!fail) return jsonOk({ project_notebook_target: 'app' });
				if (failure === 'network') throw new TypeError('Failed to fetch');
				return jsonError('UNAVAILABLE', 'Temporarily unavailable', 503);
			});
			const { client } = await renderProject();
			await waitFor(() =>
				expect(client.getQueryState(systemKeys.capabilities())?.status).toBe('error'),
			);
			expectNavigation();

			fail = false;
			await act(async () => {
				await client.refetchQueries({ queryKey: systemKeys.capabilities() });
			});
			await waitFor(() => expectNavigation({ app: true, edit: true }));
		},
	);

	it.each([null, 'unknown', '/app'])(
		'falls back to the notebook for unsupported capability target %j',
		async (target) => {
			makeFetch({
				capabilities: { project_notebook_target: target, viewer_session_modes: ['app'] },
			});
			await renderProject();
			expectNavigation();
		},
	);

	it('removes app navigation when refreshed capabilities revoke viewer app access', async () => {
		const capabilities = { project_notebook_target: 'app', viewer_session_modes: ['app'] };
		makeFetch({ role: 'viewer', capabilities });
		const { client } = await renderProject();
		expectNavigation({ app: true });

		capabilities.viewer_session_modes = [];
		await act(async () => {
			await client.refetchQueries({ queryKey: systemKeys.capabilities() });
		});
		await waitFor(expectNavigation);
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Notebook actions for Forecast' }));
		expect(screen.queryByRole('menuitem', { name: 'Run as app' })).not.toBeInTheDocument();
	});

	it('removes Edit and app navigation when an editor becomes a static viewer', async () => {
		makeFetch({
			role: 'editor',
			capabilities: { project_notebook_target: 'app', viewer_session_modes: [] },
		});
		const { client } = await renderProject();
		expectNavigation({ app: true, edit: true });

		makeFetch({
			role: 'viewer',
			capabilities: { project_notebook_target: 'app', viewer_session_modes: [] },
		});
		await act(async () => {
			await client.refetchQueries({ queryKey: projectKeys.detail(PID) });
		});
		await waitFor(expectNavigation);
	});

	it('keeps deleted notebooks without app or edit links', async () => {
		makeFetch({
			notebooks: [{ ...notebook(), status: 'deleted' }],
			capabilities: { project_notebook_target: 'app' },
		});
		await renderProject(`/projects/${PID}?status=deleted`);
		const row = within(screen.getByTestId('notebook-row'));
		expect(row.queryByRole('link')).not.toBeInTheDocument();
	});

	it('keeps app actions available in the notebook menu', async () => {
		makeFetch({ capabilities: { project_notebook_target: 'app' } });
		await renderProject();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Notebook actions for Forecast' }));
		expect(await screen.findByRole('menuitem', { name: 'Run as app' })).toBeVisible();
	});
});
