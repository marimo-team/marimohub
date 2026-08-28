import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';
import { makeFetch, renderPage, runningSession, sessionPosts } from './NotebookPage.testWorld';

describe('NotebookPage app variant', () => {
	const appSession = (overrides: Partial<Session> = {}) =>
		runningSession({ mode: 'app', source_version_id: 'ver-head', ...overrides });

	it('starts a run session, shows app chrome, and hides edit-only affordances', async () => {
		const impl = makeFetch({ role: 'editor', session: appSession() });
		const { container } = renderPage('app');

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
			).not.toBeNull(),
		);
		const [, init] = sessionPosts(impl)[0];
		expect(String(init?.body)).toContain('"mode":"app"');
		expect(screen.getByText('App')).toBeInTheDocument();
		expect(screen.getByText('Restart')).toBeInTheDocument();
		expect(screen.getByText('Stop')).toBeInTheDocument();
		expect(screen.queryByLabelText('Rename notebook')).toBeNull();
	});

	it('shows the staleness banner when the app trails the notebook head', async () => {
		makeFetch({
			role: 'editor',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
		expect(screen.getByText('Restart to update')).toBeInTheDocument();
	});

	it('suppresses the staleness banner while the notebook is being edited', async () => {
		makeFetch({
			role: 'editor',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
			projectSessions: [runningSession({ session_id: 'sess-edit', mode: 'edit' })],
		});
		const { container } = renderPage('app');

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		await waitFor(() => expect(screen.queryByText(/serving an older version/)).toBeNull());
	});

	it('does not suppress the staleness banner for a temporary editor', async () => {
		makeFetch({
			role: 'editor',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
			projectSessions: [runningSession({ session_id: 'sess-edit', mode: 'edit', ephemeral: true })],
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
	});

	it('does not suppress the banner during editing on a git-synced notebook', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: appSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
			projectSessions: [runningSession({ session_id: 'sess-edit', mode: 'edit' })],
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
	});

	it('shows no staleness banner when the app serves the head version', async () => {
		const { container } = (() => {
			makeFetch({ role: 'editor', session: appSession(), headVersion: 'ver-head' });
			return renderPage('app');
		})();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByText(/serving an older version/)).toBeNull();
	});

	it('viewer + applications: uses the app but gets no Stop/Restart controls', async () => {
		const impl = makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			session: appSession({ can: { attach: true, stop: false, develop: false } }),
		});
		const { container } = renderPage('app');

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
			).not.toBeNull(),
		);
		expect(sessionPosts(impl)).toHaveLength(1);
		expect(screen.getByText('App')).toBeInTheDocument();
		expect(screen.queryByText('Restart')).toBeNull();
		expect(screen.queryByText('Stop')).toBeNull();
	});

	it('viewer + applications: the staleness banner has no restart CTA', async () => {
		makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			session: appSession({
				source_version_id: 'ver-old',
				can: { attach: true, stop: false, develop: false },
			}),
			headVersion: 'ver-head',
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/serving an older version/)).toBeInTheDocument());
		// Restarting the shared app is editor-only; a viewer clicking through
		// would 403 on the stop half.
		expect(screen.queryByText('Restart to update')).toBeNull();
	});

	it('Restart confirms before disconnecting everyone (with the connection hint)', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({
			role: 'editor',
			session: appSession({ active_connections: 3 }),
		});
		const { container } = renderPage('app');
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		await user.click(screen.getByText('Restart'));
		// The dialog, not a teardown, is what a click produces.
		expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/About 3 people are connected/)).toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
		await waitFor(() =>
			expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
		);
	});

	it('Stop confirms too; cancel leaves the app untouched', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({ role: 'editor', session: appSession() });
		const { container } = renderPage('app');
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		await user.click(screen.getByText('Stop'));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/Anyone using it will be disconnected/)).toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		expect(container.querySelector('iframe')).not.toBeNull();
	});

	// `sandbox_url` is withheld from a caller the kernel gates would reject.
	it('a running app the caller cannot reach renders the access-ended panel', async () => {
		makeFetch({ role: 'viewer', session: appSession({ sandbox_url: undefined }) });
		const { container } = renderPage('app');

		await waitFor(() => expect(screen.getByText('Access ended')).toBeInTheDocument());
		expect(screen.getByText(/no longer have access/)).toBeInTheDocument();
		expect(container.querySelector('iframe')).toBeNull();
		// The app is still serving everyone else, so a restart could only 403.
		expect(screen.queryByText('Restart app')).toBeNull();
		expect(screen.getByText('Back')).toBeInTheDocument();
	});

	it('a viewer’s 403 renders the error panel without a Retry button', async () => {
		const impl = makeFetch({
			role: 'viewer',
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8 },
			],
			createError: { code: 'FORBIDDEN', message: "Requires 'editor' role", status: 403 },
		});
		renderPage('app');

		await waitFor(() => expect(screen.getByText(/Requires 'editor' role/)).toBeInTheDocument());
		expect(screen.queryByText('Retry')).toBeNull();
		expect(screen.queryByText('Retry with Default')).toBeNull();
		expect(screen.getByText('Back')).toBeInTheDocument();
		// The doomed request fired once — no loop.
		expect(sessionPosts(impl)).toHaveLength(1);
	});

	it('does not offer a Default bypass for a failed shared app', async () => {
		makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8 },
			],
			createError: {
				code: 'RESOURCE_EXHAUSTED',
				message: 'No nodes can schedule this profile',
				status: 429,
			},
		});
		renderPage('app');

		expect(await screen.findByText('No nodes can schedule this profile')).toBeInTheDocument();
		expect(screen.queryByText('Retry with Default')).toBeNull();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('offers a one-shot Retry with Default without replacing the stored profile', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({
			role: 'editor',
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8 },
			],
			createError: {
				code: 'RESOURCE_EXHAUSTED',
				message: 'No nodes can schedule this profile',
				status: 429,
			},
		});
		renderPage();

		expect(await screen.findByText('No nodes can schedule this profile')).toBeInTheDocument();
		expect(screen.queryByText(/a larger profile may be needed/)).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry with Default' }));

		await waitFor(() => expect(sessionPosts(impl)).toHaveLength(2));
		const retryBody = sessionPosts(impl)[1][1]?.body;
		expect(JSON.parse(String(retryBody))).toEqual({ compute_profile: 'default' });
		expect(screen.queryByRole('button', { name: 'Retry with Default' })).toBeNull();
	});
});
