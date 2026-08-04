import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import type { AuditLogEntry } from '@/types';
import AuditLogPage from './AuditLogPage';

const PROJECT_EVENT: AuditLogEntry = {
	id: 'event-2',
	schema_version: 1,
	ts: '2026-08-03T17:00:00.000Z',
	event: 'project.update',
	actor: 'user-ada',
	metadata: { project_id: 'proj-one', payload: { field: 'description' } },
};

const TOKEN_EVENT: AuditLogEntry = {
	id: 'event-1',
	schema_version: 1,
	ts: '2026-08-03T16:00:00.000Z',
	event: 'token.create',
	actor: 'system',
	metadata: { token_id: 'token-one' },
};

function usersResponse(url: string): Response | null {
	if (!url.startsWith('/api/v1/users?')) return null;
	return jsonOk({
		'user-ada': { id: 'user-ada', email: 'ada@example.com', name: 'Ada Lovelace' },
	});
}

function setup(fetchImpl: (url: string) => Promise<Response>) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			return fetchImpl(url);
		}),
	);
	const user = userEvent.setup();
	const clipboard = vi.fn((_text: string) => Promise.resolve());
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText: clipboard },
		configurable: true,
	});
	renderWithClient(<AuditLogPage />);
	return { user, clipboard };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, 'clipboard');
});

describe('AuditLogPage', () => {
	it('renders the event list, resolves actors, selects rows, and copies structured JSON', async () => {
		const { user, clipboard } = setup(async (url) => {
			const users = usersResponse(url);
			if (users) return users;
			if (url.startsWith('/api/v1/events?')) {
				return jsonOk({ items: [PROJECT_EVENT, TOKEN_EVENT], next_cursor: null });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		expect(await screen.findByRole('button', { name: /project\.update/ })).toBeInTheDocument();
		await waitFor(() => expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0));
		expect(screen.getAllByText('system').length).toBeGreaterThan(0);
		expect(screen.getAllByText('proj-one').length).toBeGreaterThan(0);
		await user.click(screen.getByText('Object(1)'));
		expect(screen.getByText('field')).toBeInTheDocument();
		expect(screen.getByText('description')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: /token\.create/ }));
		expect(screen.getByText('token_id')).toBeInTheDocument();
		expect(screen.getByText('token-one')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Copy event JSON' }));
		await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
		expect(JSON.parse(clipboard.mock.calls[0][0])).toMatchObject({
			id: 'event-1',
			metadata: { token_id: 'token-one' },
		});
	});

	it('applies exact filters and follows the next-page cursor', async () => {
		const eventUrls: string[] = [];
		const { user } = setup(async (url) => {
			const users = usersResponse(url);
			if (users) return users;
			if (url.startsWith('/api/v1/events?')) {
				eventUrls.push(url);
				const parsed = new URL(url, 'http://localhost');
				return parsed.searchParams.has('cursor')
					? jsonOk({ items: [TOKEN_EVENT], next_cursor: null })
					: jsonOk({ items: [PROJECT_EVENT], next_cursor: 'page-two' });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		await screen.findByRole('button', { name: /project\.update/ });
		await user.type(screen.getByLabelText('Event type'), 'project.update');
		await user.type(screen.getByLabelText('Actor ID'), 'user-ada');
		await user.type(screen.getByLabelText('Project ID'), 'proj-one');
		await user.click(screen.getByRole('button', { name: 'Apply' }));

		await waitFor(() => expect(eventUrls).toHaveLength(2));
		const filtered = new URL(eventUrls[1], 'http://localhost');
		expect(filtered.searchParams.get('event')).toBe('project.update');
		expect(filtered.searchParams.get('actor')).toBe('user-ada');
		expect(filtered.searchParams.get('project_id')).toBe('proj-one');
		expect(filtered.searchParams.get('limit')).toBe('50');

		await user.click(screen.getByRole('button', { name: 'Load more' }));
		await waitFor(() => expect(eventUrls).toHaveLength(3));
		expect(new URL(eventUrls[2], 'http://localhost').searchParams.get('cursor')).toBe('page-two');
		expect(await screen.findByRole('button', { name: /token\.create/ })).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Clear' }));
		expect(screen.getByLabelText('Event type')).toHaveValue('');
		expect(screen.getByLabelText('Actor ID')).toHaveValue('');
		expect(screen.getByLabelText('Project ID')).toHaveValue('');
	});

	it('shows an empty state and rejects ranges longer than 30 days before fetching', async () => {
		const eventUrls: string[] = [];
		const { user } = setup(async (url) => {
			if (url.startsWith('/api/v1/events?')) {
				eventUrls.push(url);
				return jsonOk({ items: [], next_cursor: null });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		expect(await screen.findByText('No audit events found')).toBeInTheDocument();
		await user.clear(screen.getByLabelText('From (UTC)'));
		await user.type(screen.getByLabelText('From (UTC)'), '2026-01-01');
		await user.clear(screen.getByLabelText('To (UTC)'));
		await user.type(screen.getByLabelText('To (UTC)'), '2026-01-31');
		expect(screen.getByText('Date ranges can include at most 30 days.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
		expect(eventUrls).toHaveLength(1);
	});

	it('shows API failures with a retry action', async () => {
		setup(async (url) => {
			if (url.startsWith('/api/v1/events?')) return jsonError('INTERNAL_ERROR', 'Storage failed');
			throw new Error(`unexpected fetch: ${url}`);
		});

		expect(await screen.findByText('Unable to load audit events')).toBeInTheDocument();
		expect(screen.getByText('Storage failed')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});
});
