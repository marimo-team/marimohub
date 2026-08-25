import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ProjectAlertsDialog } from './ProjectAlertsDialog';
import { projectKeys } from '@/api/queryKeys';
import { createTestQueryClient } from '@/test/render';
import type { ProjectAlertDestination, ProjectAlertKind } from '@/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KINDS: ProjectAlertKind[] = [
	'member.invited',
	'member.added',
	'member.role_changed',
	'member.removed',
	'session.takeover',
	'notebook.deleted',
	'project.deleted',
	'app.start_failed',
	'app.unavailable',
	'sync.failed',
];

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function destinationPage(items: ProjectAlertDestination[]) {
	return { items, next_cursor: null };
}

function renderDialog(
	destinations: ProjectAlertDestination[] = [],
	handler?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
	const fetchMock = vi.fn(handler ?? (async () => ok(destinationPage(destinations))));
	vi.stubGlobal('fetch', fetchMock);
	const client = createTestQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return {
		...render(
			<ProjectAlertsDialog
				isOpen
				onClose={() => {}}
				projectId="proj-0123456789abcdef"
				selectableKinds={KINDS}
				maxDestinations={10}
			/>,
			{ wrapper },
		),
		fetchMock,
		client,
	};
}

function slackDestination(
	id: string,
	overrides: Partial<ProjectAlertDestination> = {},
): ProjectAlertDestination {
	return {
		id,
		name: `Slack ${id}`,
		type: 'slack',
		kinds: ['app.unavailable'],
		enabled: false,
		verified_at: null,
		endpoint_host: 'hooks.slack.com',
		created_by: 'owner',
		created_at: '2026-08-12T12:00:00.000Z',
		updated_at: '2026-08-12T12:00:00.000Z',
		webhook_url_set: true,
		...overrides,
	} as ProjectAlertDestination;
}

async function patchBody(
	fetchMock: ReturnType<typeof renderDialog>['fetchMock'],
): Promise<unknown> {
	await waitFor(() =>
		expect(
			fetchMock.mock.calls.some(([input, init]) =>
				input instanceof Request ? input.method === 'PATCH' : init?.method === 'PATCH',
			),
		).toBe(true),
	);
	const [input, init] = fetchMock.mock.calls.find(([callInput, callInit]) =>
		callInput instanceof Request ? callInput.method === 'PATCH' : callInit?.method === 'PATCH',
	)!;
	return input instanceof Request ? input.clone().json() : JSON.parse(String(init?.body));
}

function testRequestIdempotencyKeys(
	fetchMock: ReturnType<typeof renderDialog>['fetchMock'],
): (string | null)[] {
	return fetchMock.mock.calls
		.filter(([input, init]) =>
			input instanceof Request ? input.method === 'POST' : init?.method === 'POST',
		)
		.map(([input, init]) =>
			input instanceof Request
				? input.headers.get('idempotency-key')
				: new Headers(init?.headers).get('idempotency-key'),
		);
}

beforeEach(() => {
	vi.mocked(toast.success).mockClear();
	vi.mocked(toast.error).mockClear();
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
});

afterEach(() => vi.unstubAllGlobals());

describe('ProjectAlertsDialog', () => {
	it('selects every actionable event for a new destination', async () => {
		const user = userEvent.setup();
		renderDialog();
		await waitFor(() => expect(screen.getByText('No alert destinations')).toBeInTheDocument());
		await user.click(screen.getByRole('button', { name: 'Add destination' }));
		expect(screen.getAllByRole('checkbox')).toHaveLength(10);
		for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeChecked();
	});

	it('never places stored endpoint or secret material in edit fields', async () => {
		const user = userEvent.setup();
		renderDialog([
			{
				id: 'alert-0123456789abcdef',
				name: 'Production hook',
				type: 'webhook',
				kinds: ['app.unavailable'],
				enabled: false,
				verified_at: null,
				endpoint_host: 'alerts.example.com',
				created_by: 'owner',
				created_at: '2026-08-12T12:00:00.000Z',
				updated_at: '2026-08-12T12:00:00.000Z',
				url_set: true,
				signing_secret_set: true,
			},
		]);
		await user.click(await screen.findByRole('button', { name: 'Edit Production hook' }));
		const endpoint = screen.getByRole('textbox', { name: 'Webhook URL' });
		expect(endpoint).toHaveValue('');
		expect(endpoint).toHaveAttribute('placeholder', expect.stringContaining('alerts.example.com'));
		expect(screen.getByLabelText('HMAC signing secret')).toHaveValue('');
	});

	it('disables creation when the project has reached its destination limit', async () => {
		renderDialog(
			Array.from({ length: 10 }, (_, index) =>
				slackDestination(`alert-limit-${index.toString().padStart(8, '0')}`),
			),
		);
		await screen.findByText('Slack alert-limit-00000000');
		expect(await screen.findByRole('button', { name: 'Add destination' })).toBeDisabled();
	});

	it('allows enablement only for verified destinations', async () => {
		renderDialog([
			slackDestination('alert-unverified-0001', { name: 'Unverified' }),
			slackDestination('alert-verified-00002', {
				name: 'Verified',
				verified_at: '2026-08-12T12:05:00.000Z',
			}),
		]);
		const enables = await screen.findAllByRole('button', { name: 'Enable' });
		expect(enables[0]).toBeDisabled();
		expect(enables[1]).toBeEnabled();
	});

	it('does not allow a destination with no selected events to be saved', async () => {
		const user = userEvent.setup();
		renderDialog();
		await user.click(await screen.findByRole('button', { name: 'Add destination' }));
		await user.type(screen.getByLabelText('Name'), 'No events');
		await user.type(
			screen.getByLabelText('Slack incoming webhook URL'),
			'https://hooks.example.com',
		);
		for (const checkbox of screen.getAllByRole('checkbox')) await user.click(checkbox);
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('requires endpoint and signing-secret fields before creating a destination', async () => {
		const user = userEvent.setup();
		renderDialog();
		await user.click(await screen.findByRole('button', { name: 'Add destination' }));
		await user.type(screen.getByLabelText('Name'), 'Webhook');
		await user.selectOptions(screen.getByLabelText('Destination type'), 'webhook');
		const save = screen.getByRole('button', { name: 'Save' });
		expect(save).toBeDisabled();
		await user.type(screen.getByLabelText('Webhook URL'), 'https://events.example.com/hook');
		expect(save).toBeDisabled();
		await user.type(screen.getByLabelText('HMAC signing secret'), 'secret');
		expect(save).toBeEnabled();
	});

	it('shows API failures while saving and keeps the editor open', async () => {
		const user = userEvent.setup();
		renderDialog([], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			if (method === 'POST') {
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'VALIDATION_ERROR', message: 'Invalid webhook URL' },
					}),
					{ status: 422, headers: { 'content-type': 'application/json' } },
				);
			}
			return ok(destinationPage([]));
		});
		await user.click(await screen.findByRole('button', { name: 'Add destination' }));
		await user.type(screen.getByLabelText('Name'), 'Broken');
		await user.type(
			screen.getByLabelText('Slack incoming webhook URL'),
			'https://hooks.example.com/broken',
		);
		await user.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid webhook URL'));
		expect(screen.getByRole('heading', { name: 'New destination' })).toBeInTheDocument();
	});

	it('confirms deletion before removing a destination', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-delete-000001', { name: 'Production Slack' });
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			return method === 'DELETE' ? ok(undefined) : ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Delete Production Slack' }));
		expect(screen.getByRole('heading', { name: 'Delete alert destination' })).toBeInTheDocument();
		expect(
			fetchMock.mock.calls.some(([input, init]) =>
				input instanceof Request ? input.method === 'DELETE' : init?.method === 'DELETE',
			),
		).toBe(false);
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Alert destination deleted.'));
	});

	it('shows delete conflicts and leaves the confirmation open', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-delete-000002', { name: 'Production Slack' });
		renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			if (method === 'DELETE') {
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'PRECONDITION_FAILED', message: 'Stale destination' },
					}),
					{ status: 412, headers: { 'content-type': 'application/json' } },
				);
			}
			return ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Delete Production Slack' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				'Someone else changed this item. Reload it and try again.',
			),
		);
		expect(screen.getByRole('heading', { name: 'Delete alert destination' })).toBeInTheDocument();
	});

	it('reuses the idempotency key when a test delivery is retried', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-test-00000001', { name: 'Production Slack' });
		let attempts = 0;
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			if (method !== 'POST') return ok(destinationPage([destination]));
			attempts++;
			if (attempts === 1) {
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'Delivery response was lost' },
					}),
					{ status: 503, headers: { 'content-type': 'application/json' } },
				);
			}
			return ok({ ...destination, verified_at: '2026-08-12T12:05:00.000Z' });
		});
		const button = await screen.findByRole('button', { name: 'Test' });

		await user.click(button);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Delivery response was lost'));
		await user.click(button);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test alert delivered.'));

		const keys = testRequestIdempotencyKeys(fetchMock);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).toBe(keys[0]);
	});

	it('starts a new test operation when the destination version changes', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-test-00000002', { name: 'Production Slack' });
		let attempts = 0;
		const { client, fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			if (method !== 'POST') return ok(destinationPage([destination]));
			attempts++;
			return new Response(
				JSON.stringify({
					success: false,
					error: { code: 'SERVICE_UNAVAILABLE', message: 'Delivery response was lost' },
				}),
				{ status: 503, headers: { 'content-type': 'application/json' } },
			);
		});

		await user.click(await screen.findByRole('button', { name: 'Test' }));
		await waitFor(() => expect(attempts).toBe(1));

		client.setQueryData(projectKeys.alerts('proj-0123456789abcdef'), [
			{
				...destination,
				name: 'Updated Slack',
				updated_at: '2026-08-12T12:01:00.000Z',
			},
		]);
		await screen.findByText('Updated Slack');
		await user.click(screen.getByRole('button', { name: 'Test' }));
		await waitFor(() => expect(attempts).toBe(2));

		const keys = testRequestIdempotencyKeys(fetchMock);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBeTruthy();
		expect(keys[1]).not.toBe(keys[0]);
	});

	it('omits kinds from an edit when the selection is untouched', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-edit-00000002', {
			name: 'Production Slack',
			kinds: ['app.unavailable', 'unknown'],
		});
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			return method === 'PATCH' ? ok(destination) : ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Edit Production Slack' }));
		await user.clear(screen.getByLabelText('Name'));
		await user.type(screen.getByLabelText('Name'), 'Renamed Slack');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const body = await patchBody(fetchMock);
		expect(body).toMatchObject({ name: 'Renamed Slack' });
		expect(body).not.toHaveProperty('kinds');
	});

	it('sends kinds on an edit once the selection changes', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-edit-00000003', { name: 'Production Slack' });
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			return method === 'PATCH' ? ok(destination) : ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Edit Production Slack' }));
		await user.click(screen.getByRole('checkbox', { name: 'App start failed' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const body = await patchBody(fetchMock);
		expect(body).toMatchObject({ kinds: ['app.unavailable', 'app.start_failed'] });
	});

	it('preserves unknown kinds when a visible selection changes', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-edit-00000004', {
			name: 'Production Slack',
			kinds: ['app.unavailable', 'unknown'],
		});
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			return method === 'PATCH' ? ok(destination) : ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Edit Production Slack' }));
		await user.click(screen.getByRole('checkbox', { name: 'App start failed' }));
		await user.click(screen.getByRole('button', { name: 'Save' }));

		const body = await patchBody(fetchMock);
		expect(body).toMatchObject({ kinds: ['app.unavailable', 'app.start_failed', 'unknown'] });
	});

	it('allows removing the last visible kind while preserving an unknown kind', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-edit-00000005', {
			name: 'Production Slack',
			kinds: ['app.unavailable', 'unknown'],
		});
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			return method === 'PATCH' ? ok(destination) : ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Edit Production Slack' }));
		await user.click(screen.getByRole('checkbox', { name: 'App unavailable' }));
		const save = screen.getByRole('button', { name: 'Save' });
		expect(save).toBeEnabled();
		await user.click(save);

		const body = await patchBody(fetchMock);
		expect(body).toMatchObject({ kinds: ['unknown'] });
	});

	it('sends only replacement material entered during an edit', async () => {
		const user = userEvent.setup();
		const destination = slackDestination('alert-edit-00000001', {
			name: 'Production Slack',
			verified_at: '2026-08-12T12:05:00.000Z',
			enabled: true,
		});
		const { fetchMock } = renderDialog([destination], async (input, init) => {
			const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
			return method === 'PATCH'
				? ok({ ...destination, enabled: false, verified_at: null })
				: ok(destinationPage([destination]));
		});
		await user.click(await screen.findByRole('button', { name: 'Edit Production Slack' }));
		await user.type(
			screen.getByLabelText('Slack incoming webhook URL'),
			'https://hooks.example.com/replacement',
		);
		await user.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(([input, init]) =>
					input instanceof Request ? input.method === 'PATCH' : init?.method === 'PATCH',
				),
			).toBe(true),
		);
		const [patchInput, patchInit] = fetchMock.mock.calls.find(([input, init]) =>
			input instanceof Request ? input.method === 'PATCH' : init?.method === 'PATCH',
		)!;
		const body =
			patchInput instanceof Request
				? await patchInput.clone().json()
				: JSON.parse(String(patchInit?.body));
		expect(body).toMatchObject({
			name: 'Production Slack',
			webhook_url: 'https://hooks.example.com/replacement',
		});
		expect(body).not.toHaveProperty('enabled');
		expect(JSON.stringify(body)).not.toContain('hooks.slack.com');
	});
});
