import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sessionKeys } from '@/api/queryKeys';
import {
	NID,
	PID,
	makeFetch,
	renderPage,
	runningSession,
	sessionPosts,
} from './NotebookPage.testWorld';

describe('NotebookPage viewer modes', () => {
	it('starts shared editing without requesting exclusive ownership state', async () => {
		const fetch = makeFetch({ role: 'editor', editorSharing: 'shared', editorStateFailures: 1 });
		renderPage();

		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
		expect(
			fetch.mock.calls.some(([url]) => String(url).endsWith(`/notebooks/${NID}/editor-session`)),
		).toBe(false);
	});

	it('asks before starting compute when another editor owns an exclusive session', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'active' },
		});
		renderPage();
		expect(await screen.findByText(/owns the saved editing session/)).toBeInTheDocument();
		expect(sessionPosts(fetch)).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Open temporary sandbox' }));
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
		expect(JSON.parse(String(sessionPosts(fetch)[0]?.[1]?.body))).toMatchObject({
			edit_intent: 'temporary',
		});
	});

	it('waits for the current user before deciding that an exclusive holder is someone else', async () => {
		let resolveMe!: (value: {
			id: string;
			email: string;
			logout_url: null;
			is_super_admin: boolean;
		}) => void;
		const mePromise = new Promise<{
			id: string;
			email: string;
			logout_url: null;
			is_super_admin: boolean;
		}>((resolve) => {
			resolveMe = resolve;
		});
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			mePromise,
		});
		renderPage();

		await waitFor(() =>
			expect(
				fetch.mock.calls.some(([url]) => String(url).endsWith(`/notebooks/${NID}/editor-session`)),
			).toBe(true),
		);
		expect(screen.queryByText(/owns the saved editing session/)).toBeNull();
		expect(sessionPosts(fetch)).toHaveLength(0);

		resolveMe({
			id: 'me',
			email: 'me@example.com',
			logout_url: null,
			is_super_admin: false,
		});
		expect(await screen.findByText(/owns the saved editing session/)).toBeInTheDocument();
	});

	it('does not classify an exclusive holder when the current-user request fails', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'me', activity: 'idle' },
			meFailures: 1,
		});
		renderPage();

		expect(
			await screen.findByText('Unable to confirm whether you own the editor sandbox.'),
		).toBeInTheDocument();
		expect(screen.queryByText(/owns the saved editing session/)).toBeNull();
		expect(sessionPosts(fetch)).toHaveLength(0);

		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
	});

	it('shows a transfer in progress without offering another takeover', async () => {
		makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			editorCanTakeOver: false,
			editorTransfer: 'draining',
		});
		renderPage();

		expect(await screen.findByText(/editing transfer is already in progress/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Takeover in progress' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Open temporary sandbox' })).toBeEnabled();
	});

	it('warns and completes an exclusive takeover before starting the replacement', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
		});
		renderPage();
		await user.click(await screen.findByRole('button', { name: 'Take over editing' }));
		expect(screen.getByText(/Their work will be saved/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Take Over' }));
		await waitFor(() =>
			expect(
				fetch.mock.calls.some(
					([url, init]) =>
						String(url).endsWith('/editor-session/takeover') && init?.method === 'POST',
				),
			).toBe(true),
		);
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
	});

	it('starts a persistent replacement after takeover from a temporary sandbox', async () => {
		const user = userEvent.setup();
		const temporary = runningSession({
			session_id: 'sess-temporary',
			ephemeral: true,
			editor_sandbox_sharing: 'exclusive',
		});
		const persistent = runningSession({
			session_id: 'sess-persistent',
			editor_sandbox_sharing: 'exclusive',
		});
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			sessionResponses: [temporary, persistent],
		});
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open temporary sandbox' }));
		await screen.findByText(/Temporary sandbox/);
		await user.click(screen.getByRole('button', { name: 'Take over editing' }));
		await user.click(screen.getByRole('button', { name: 'Take Over' }));

		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(2));
		const [temporaryPost, replacementPost] = sessionPosts(fetch);
		expect(JSON.parse(String(temporaryPost?.[1]?.body))).toMatchObject({
			edit_intent: 'temporary',
		});
		expect(replacementPost?.[1]?.body).toBeUndefined();
	});

	it('shows an ownership-state error and retries before starting compute', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorStateFailures: 1,
		});
		renderPage();

		expect(
			await screen.findByText('Unable to check who owns the editor sandbox.'),
		).toBeInTheDocument();
		expect(sessionPosts(fetch)).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(sessionPosts(fetch)).toHaveLength(1));
	});

	it('keeps a temporary editor visible when an ownership refresh fails', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'editor',
			editorSharing: 'exclusive',
			editorOwner: { id: 'other', activity: 'idle' },
			editorStateFailOn: [2],
			session: runningSession({ ephemeral: true, editor_sandbox_sharing: 'exclusive' }),
		});
		const { client, container } = renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open temporary sandbox' }));
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		await act(async () => {
			await client.refetchQueries({ queryKey: sessionKeys.editor(PID, NID) });
		});

		expect(
			fetch.mock.calls.filter(([url]) => String(url).endsWith('/editor-session')),
		).toHaveLength(2);
		expect(screen.queryByText('Unable to check who owns the editor sandbox.')).toBeNull();
		expect(container.querySelector('iframe')).not.toBeNull();
	});

	it('editor: starts a session and embeds the kernel iframe, no banner', async () => {
		const impl = makeFetch({ role: 'editor' });
		const { container } = renderPage();

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
			).not.toBeNull(),
		);
		expect(document.title).toBe('Forecast · marimohub');
		expect(sessionPosts(impl)).toHaveLength(1);
		expect(screen.queryByText(/won't be saved/)).toBeNull();
	});

	it('stops a viewer ephemeral session without a shared-sandbox warning', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			session: runningSession({
				ephemeral: true,
				editor_sandbox_sharing: 'shared',
			}),
		});
		renderPage();

		await screen.findByText(/session is temporary/);
		await user.click(screen.getByRole('button', { name: 'Stop' }));
		await waitFor(() =>
			expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
		);
		expect(screen.queryByText('Stop Shared Sandbox')).toBeNull();
	});

	it('uses a private restart warning for a viewer ephemeral session', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			sourceType: 'git',
			headVersion: 'ver-head',
			session: runningSession({
				ephemeral: true,
				editor_sandbox_sharing: 'shared',
				source_version_id: 'ver-old',
			}),
		});
		renderPage();

		await user.click(await screen.findByText('Restart to update'));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText('Restart Session')).toBeInTheDocument();
		expect(within(dialog).queryByText(/All connected editors/)).toBeNull();
	});

	it('dark theme: forces the embedded app onto ?theme=dark', async () => {
		localStorage.setItem('marimohub-theme', 'dark');
		makeFetch({ role: 'editor' });
		const { container } = renderPage();

		await waitFor(() =>
			expect(
				container.querySelector('iframe[src="https://sandbox.example/kernel?theme=dark"]'),
			).not.toBeNull(),
		);
	});

	it('shows the selected compute profile in the header', async () => {
		makeFetch({
			role: 'editor',
			session: runningSession({ compute_profile: 'large' }),
			computeProfile: 'large',
			computeProfileOverride: 'editors',
			computeProfiles: [
				{ name: 'small', cpu: 1 },
				{ name: 'large', cpu: 8, memory_bytes: 32 * 1024 ** 3 },
			],
		});
		renderPage();

		expect(await screen.findByText('large — 8 CPU · 32 Gi')).toBeInTheDocument();
	});

	it('viewer + static: renders the snapshot sandboxed, never starts a session', async () => {
		const impl = makeFetch({ role: 'viewer', html: '<html><body>outputs</body></html>' });
		const { container } = renderPage();

		await waitFor(() => expect(screen.getByText(/Static snapshot of outputs/)).toBeInTheDocument());
		const iframe = container.querySelector('iframe');
		expect(iframe).not.toBeNull();
		expect(iframe!.getAttribute('srcdoc')).toContain('outputs');
		// Opaque origin: no allow-same-origin, unlike the live-kernel iframe.
		expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
		expect(sessionPosts(impl)).toHaveLength(0);
	});

	it('viewer + static without a snapshot: empty state, never starts a session', async () => {
		const impl = makeFetch({ role: 'viewer', html: null });
		renderPage();

		await waitFor(() => expect(screen.getByText('No outputs yet')).toBeInTheDocument());
		expect(sessionPosts(impl)).toHaveLength(0);
	});

	it('viewer + applications: still the static view on the EDIT page (apps ≠ edit kernels)', async () => {
		const impl = makeFetch({
			role: 'viewer',
			viewerMode: 'applications',
			html: '<html><body>outputs</body></html>',
		});
		renderPage();

		await waitFor(() => expect(screen.getByText(/Static snapshot of outputs/)).toBeInTheDocument());
		expect(sessionPosts(impl)).toHaveLength(0);
	});

	it('viewer + ephemeral-sandbox: starts a session and shows the not-saved banner', async () => {
		const impl = makeFetch({
			role: 'viewer',
			viewerMode: 'ephemeral-sandbox',
			session: runningSession({ ephemeral: true }),
		});
		const { container } = renderPage();

		await waitFor(() => expect(screen.getByText(/won't be saved/)).toBeInTheDocument());
		expect(
			container.querySelector('iframe[src="https://sandbox.example/kernel?theme=light"]'),
		).not.toBeNull();
		expect(sessionPosts(impl)).toHaveLength(1);
	});
});
