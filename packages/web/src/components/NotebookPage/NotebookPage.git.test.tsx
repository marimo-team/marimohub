import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';
import {
	changeRequestBody,
	makeFetch,
	renderPage,
	runningSession,
	sessionPosts,
} from './NotebookPage.testWorld';

describe('NotebookPage git-synced editor', () => {
	const gitEditSession = (overrides: Partial<Session> = {}) =>
		runningSession({ source_version_id: 'ver-head', ...overrides });

	it('shows the updated-on-GitHub banner when the session trails the head', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		renderPage();

		await waitFor(() =>
			expect(screen.getByText(/updated in its git repository/)).toBeInTheDocument(),
		);
		expect(screen.getByText('Restart to update')).toBeInTheDocument();
	});

	it('shows no banner when the session serves the synced head', async () => {
		makeFetch({ role: 'editor', sourceType: 'git', session: gitEditSession() });
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByText(/updated in its git repository/)).toBeNull();
	});

	it('header shows the repo chip whose popover links to the source on GitHub', async () => {
		const user = userEvent.setup();
		makeFetch({ role: 'editor', sourceType: 'git', session: gitEditSession() });
		renderPage();

		await user.click(
			await screen.findByRole('button', { name: 'Synced from a git repository — details' }),
		);
		const popover = await screen.findByRole('dialog');
		expect(within(popover).getByRole('link', { name: 'org/repo' })).toHaveAttribute(
			'href',
			'https://github.com/org/repo',
		);
		expect(within(popover).getByRole('link', { name: 'deadbee' })).toHaveAttribute(
			'href',
			'https://github.com/org/repo/commit/deadbeefcafe0123',
		);
		expect(within(popover).getByRole('link', { name: /View source on GitHub/ })).toHaveAttribute(
			'href',
			'https://github.com/org/repo/blob/deadbeefcafe0123/app.py',
		);
	});

	it('the app view shows no repo chip', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({ mode: 'app' }),
		});
		const { container } = renderPage('app');

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(
			screen.queryByRole('button', { name: 'Synced from a git repository — details' }),
		).toBeNull();
	});

	it('shows the banner without a restart CTA when the caller cannot stop the session', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({
				source_version_id: 'ver-old',
				can: { attach: true, stop: false, develop: false },
			}),
			headVersion: 'ver-head',
		});
		renderPage();

		await waitFor(() =>
			expect(screen.getByText(/updated in its git repository/)).toBeInTheDocument(),
		);
		expect(screen.queryByText('Restart to update')).toBeNull();
	});

	it('shows no banner on a local notebook even when versions differ', async () => {
		makeFetch({
			role: 'editor',
			session: gitEditSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByText(/updated in its git repository/)).toBeNull();
	});

	it('Restart to update confirms (cancel is a no-op), then tears down and starts fresh', async () => {
		const user = userEvent.setup();
		const impl = makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession({ source_version_id: 'ver-old' }),
			headVersion: 'ver-head',
		});
		const { container } = renderPage();
		await waitFor(() => expect(screen.getByText('Restart to update')).toBeInTheDocument());

		await user.click(screen.getByText('Restart to update'));
		// The dialog, not a teardown, is what a click produces.
		expect(sessionPosts(impl)).toHaveLength(1);
		let dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/latest synced version/)).toBeInTheDocument();

		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(impl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
		expect(container.querySelector('iframe')).not.toBeNull();

		await user.click(screen.getByText('Restart to update'));
		dialog = await screen.findByRole('dialog');
		await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
		await waitFor(() => expect(sessionPosts(impl)).toHaveLength(2));
		const deletes = impl.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deletes).toHaveLength(1);
	});

	it('lets a manager open a pull request from a persistent running session', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
		});
		const popup = {
			opener: window,
			location: { href: 'about:blank' },
			close: vi.fn(),
		};
		vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await waitFor(() => expect(popup.location.href).toBe('https://github.com/org/repo/pull/17'));
		expect(popup.opener).toBeNull();
		expect(
			fetch.mock.calls.some(
				([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
			),
		).toBe(true);
		expect(await screen.findByRole('button', { name: 'View PR' })).toBeEnabled();
	});

	it('views the published PR without creating another proposal', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
		});
		const pendingPopup = {
			opener: window,
			location: { href: 'about:blank' },
			close: vi.fn(),
		};
		const viewPopup = { opener: window };
		vi.spyOn(window, 'open')
			.mockReturnValueOnce(pendingPopup as unknown as Window)
			.mockReturnValueOnce(viewPopup as unknown as Window);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		const viewButton = await screen.findByRole('button', { name: 'View PR' });
		await user.click(viewButton);

		expect(window.open).toHaveBeenLastCalledWith('https://github.com/org/repo/pull/17', '_blank');
		expect(viewPopup.opener).toBeNull();
		expect(
			fetch.mock.calls.filter(
				([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
			),
		).toHaveLength(1);
	});

	it('updates the current PR and replaces it only when creating a new PR', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
		});
		const firstPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const updatePopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const newPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const viewPopup = { opener: window };
		vi.spyOn(window, 'open')
			.mockReturnValueOnce(firstPopup as unknown as Window)
			.mockReturnValueOnce(updatePopup as unknown as Window)
			.mockReturnValueOnce(newPopup as unknown as Window)
			.mockReturnValueOnce(viewPopup as unknown as Window);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await screen.findByRole('button', { name: 'View PR' });
		await user.click(screen.getByRole('button', { name: 'pull request options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Update PR' }));
		await waitFor(() =>
			expect(updatePopup.location.href).toBe('https://github.com/org/repo/pull/17'),
		);

		await user.click(screen.getByRole('button', { name: 'pull request options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Create new PR' }));
		await waitFor(() => expect(newPopup.location.href).toBe('https://github.com/org/repo/pull/18'));
		await user.click(screen.getByRole('button', { name: 'View PR' }));
		expect(window.open).toHaveBeenLastCalledWith('https://github.com/org/repo/pull/18', '_blank');

		const requests = fetch.mock.calls.filter(
			([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
		);
		expect(requests).toHaveLength(3);
		expect(JSON.parse(String(requests[0]?.[1]?.body))).not.toHaveProperty('target_proposal_id');
		expect(JSON.parse(String(requests[1]?.[1]?.body))).toMatchObject({
			target_proposal_id: 'prop-1234567890abcdef',
		});
		expect(JSON.parse(String(requests[2]?.[1]?.body))).not.toHaveProperty('target_proposal_id');
		const keys = requests.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
		expect(new Set(keys).size).toBe(3);
	});

	it('targets each subsequent update at the latest published proposal', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
		});
		vi.spyOn(window, 'open').mockImplementation(
			() =>
				({
					opener: window,
					location: { href: 'about:blank' },
					close: vi.fn(),
				}) as unknown as Window,
		);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await screen.findByRole('button', { name: 'View PR' });
		for (let index = 0; index < 2; index++) {
			await user.click(screen.getByRole('button', { name: 'pull request options' }));
			await user.click(await screen.findByRole('menuitem', { name: 'Update PR' }));
			await waitFor(() =>
				expect(
					fetch.mock.calls.filter(
						([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
					),
				).toHaveLength(index + 2),
			);
			if (index === 0) {
				await waitFor(() =>
					expect(screen.getByRole('button', { name: 'pull request options' })).toBeEnabled(),
				);
			}
		}

		const requests = fetch.mock.calls.filter(
			([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
		);
		expect(JSON.parse(String(requests[1]?.[1]?.body))).toMatchObject({
			target_proposal_id: 'prop-1234567890abcdef',
		});
		expect(JSON.parse(String(requests[2]?.[1]?.body))).toMatchObject({
			target_proposal_id: 'prop-2234567890abcdef',
		});
	});

	it('keeps the current PR and idempotency key when an update transiently fails', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
			changeRequestFailOn: [2],
		});
		const openPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const failedPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const retryPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		vi.spyOn(window, 'open')
			.mockReturnValueOnce(openPopup as unknown as Window)
			.mockReturnValueOnce(failedPopup as unknown as Window)
			.mockReturnValueOnce(retryPopup as unknown as Window);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await screen.findByRole('button', { name: 'View PR' });
		await user.click(screen.getByRole('button', { name: 'pull request options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Update PR' }));
		await waitFor(() => expect(failedPopup.close).toHaveBeenCalledOnce());
		expect(screen.getByRole('button', { name: 'View PR' })).toBeEnabled();
		await user.click(screen.getByRole('button', { name: 'pull request options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Update PR' }));
		await waitFor(() =>
			expect(retryPopup.location.href).toBe('https://github.com/org/repo/pull/17'),
		);

		const requests = fetch.mock.calls.filter(
			([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
		);
		const updateRequests = requests.slice(1);
		expect(updateRequests).toHaveLength(2);
		const firstUpdateKey = new Headers(updateRequests[0]?.[1]?.headers).get('idempotency-key');
		expect(firstUpdateKey).not.toBeNull();
		expect(new Headers(updateRequests[1]?.[1]?.headers).get('idempotency-key')).toBe(
			firstUpdateKey,
		);
		expect(updateRequests.map(([, init]) => changeRequestBody(init).target_proposal_id)).toEqual([
			'prop-1234567890abcdef',
			'prop-1234567890abcdef',
		]);
	});

	it('keeps the old PR selected when creating a replacement PR fails', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
			changeRequestFailOn: [2],
		});
		const openPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const failedPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const viewPopup = { opener: window };
		vi.spyOn(window, 'open')
			.mockReturnValueOnce(openPopup as unknown as Window)
			.mockReturnValueOnce(failedPopup as unknown as Window)
			.mockReturnValueOnce(viewPopup as unknown as Window);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await screen.findByRole('button', { name: 'View PR' });
		await user.click(screen.getByRole('button', { name: 'pull request options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Create new PR' }));
		await waitFor(() => expect(failedPopup.close).toHaveBeenCalledOnce());
		await user.click(screen.getByRole('button', { name: 'View PR' }));

		expect(window.open).toHaveBeenLastCalledWith('https://github.com/org/repo/pull/17', '_blank');
		expect(viewPopup.opener).toBeNull();
		expect(
			fetch.mock.calls.filter(
				([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
			),
		).toHaveLength(2);
	});

	it('rotates only the failed update key when its proposal must be recaptured', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
			changeRequestFailOn: [2],
			changeRequestFailure: {
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: 'The proposal payload expired; retry with a new idempotency key',
				status: 409,
			},
		});
		vi.spyOn(window, 'open').mockImplementation(
			() =>
				({
					opener: window,
					location: { href: 'about:blank' },
					close: vi.fn(),
				}) as unknown as Window,
		);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await screen.findByRole('button', { name: 'View PR' });
		for (let index = 0; index < 2; index++) {
			await user.click(screen.getByRole('button', { name: 'pull request options' }));
			await user.click(await screen.findByRole('menuitem', { name: 'Update PR' }));
			await waitFor(() =>
				expect(
					fetch.mock.calls.filter(
						([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST',
					),
				).toHaveLength(index + 2),
			);
			if (index === 0) {
				await waitFor(() =>
					expect(screen.getByRole('button', { name: 'pull request options' })).toBeEnabled(),
				);
			}
		}

		const updates = fetch.mock.calls
			.filter(([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST')
			.slice(1);
		expect(updates).toHaveLength(2);
		expect(new Headers(updates[0]?.[1]?.headers).get('idempotency-key')).not.toBe(
			new Headers(updates[1]?.[1]?.headers).get('idempotency-key'),
		);
		expect(updates.map(([, init]) => changeRequestBody(init).target_proposal_id)).toEqual([
			'prop-1234567890abcdef',
			'prop-1234567890abcdef',
		]);
	});

	it('navigates the current tab when the pull-request popup is blocked', async () => {
		const user = userEvent.setup();
		makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
		});
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign });
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		renderPage();

		await user.click(await screen.findByRole('button', { name: 'Open PR' }));
		await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/org/repo/pull/17'));
		expect(open).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledWith('about:blank', '_blank');
	});

	it('reuses the idempotency key when a manager retries a failed publication', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
			changeRequestFailures: 1,
		});
		const firstPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const secondPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		vi.spyOn(window, 'open')
			.mockReturnValueOnce(firstPopup as unknown as Window)
			.mockReturnValueOnce(secondPopup as unknown as Window);
		renderPage();

		const button = await screen.findByRole('button', { name: 'Open PR' });
		await user.click(button);
		await waitFor(() => expect(firstPopup.close).toHaveBeenCalledOnce());
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await waitFor(() =>
			expect(secondPopup.location.href).toBe('https://github.com/org/repo/pull/17'),
		);

		const keys = fetch.mock.calls
			.filter(([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST')
			.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
		expect(keys).toHaveLength(2);
		expect(keys[1]).toBe(keys[0]);
	});

	it('rotates the idempotency key when the proposal must be recaptured', async () => {
		const user = userEvent.setup();
		const fetch = makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
			changeRequestFailures: 1,
			changeRequestFailure: {
				code: 'PROPOSAL_RETRY_REQUIRED',
				message: 'The proposal payload expired; retry with a new idempotency key',
				status: 409,
			},
		});
		const firstPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		const secondPopup = { opener: window, location: { href: 'about:blank' }, close: vi.fn() };
		vi.spyOn(window, 'open')
			.mockReturnValueOnce(firstPopup as unknown as Window)
			.mockReturnValueOnce(secondPopup as unknown as Window);
		renderPage();

		const button = await screen.findByRole('button', { name: 'Open PR' });
		await user.click(button);
		await waitFor(() => expect(firstPopup.close).toHaveBeenCalledOnce());
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await waitFor(() =>
			expect(secondPopup.location.href).toBe('https://github.com/org/repo/pull/17'),
		);

		const keys = fetch.mock.calls
			.filter(([url, init]) => String(url).endsWith('/change-requests') && init?.method === 'POST')
			.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
		expect(keys).toHaveLength(2);
		expect(keys[1]).not.toBe(keys[0]);
	});

	it('does not offer pull-request publishing to project editors', async () => {
		makeFetch({
			role: 'editor',
			sourceType: 'git',
			session: gitEditSession(),
			sourceControlProviders: ['github'],
		});
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByRole('button', { name: 'Open PR' })).toBeNull();
	});

	it('handles an older capability response without source-control fields', async () => {
		makeFetch({
			role: 'manager',
			sourceType: 'git',
			session: gitEditSession(),
			omitSourceControlCapability: true,
		});
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(screen.queryByRole('button', { name: 'Open PR' })).toBeNull();
	});
});
