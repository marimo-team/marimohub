import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ProjectMembersDialog } from './ProjectMembersDialog';
import type { ProjectDetail, ProjectMember } from '@/types';

const PID = 'proj-1';
const OWNER = 'u-owner';
const EDITOR = 'u-edit';

const project = (yourRole: ProjectDetail['your_role']): ProjectDetail =>
	({ id: PID, name: 'Sales', owner: OWNER, your_role: yourRole }) as ProjectDetail;

const MEMBERS: ProjectMember[] = [
	{ user_id: OWNER, role: 'admin' },
	{ user_id: EDITOR, role: 'editor' },
];

const DIRECTORY = {
	[OWNER]: { id: OWNER, email: 'olive@x.io', name: 'Olive Owner' },
	[EDITOR]: { id: EDITOR, email: 'eddie@x.io', name: 'Eddie Editor' },
};

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

function conflict(message: string) {
	return new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), {
		status: 409,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Route every request the dialog makes to a canned response, recording the
 * mutating calls so tests can assert on them.
 */
function makeFetch({ addResponse }: { addResponse?: Response } = {}) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body
			? (JSON.parse(init.body as string) as Record<string, unknown>)
			: undefined;
		if (method !== 'GET') calls.push({ url, method, body });

		if (method === 'POST' && url.endsWith(`/projects/${PID}/members`))
			return addResponse ?? ok(project('admin'));
		if (method === 'PUT' && url.includes(`/projects/${PID}/members/`)) return ok(project('admin'));
		if (method === 'DELETE' && url.includes(`/projects/${PID}/members/`)) return ok(null);
		if (url.includes(`/projects/${PID}/members`)) return ok(MEMBERS);
		if (url.includes('/users')) return ok(DIRECTORY);
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

async function renderDialog(yourRole: ProjectDetail['your_role']) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(<ProjectMembersDialog isOpen onClose={onClose} project={project(yourRole)} />, {
		wrapper,
	});
	// Wait for the member list and the user directory to resolve.
	await waitFor(() => expect(screen.getByText('Eddie Editor')).toBeInTheDocument());
	return onClose;
}

beforeEach(() => {
	// jsdom has no matchMedia; Tooltip's mobile check needs it.
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ProjectMembersDialog — admin', () => {
	it('renders resolved member names with role and remove controls', async () => {
		makeFetch();
		await renderDialog('admin');

		expect(screen.getByText('Olive Owner')).toBeInTheDocument();
		// The owner's membership is fixed: no role select, no remove button.
		expect(screen.getByText(/owner · admin/)).toBeInTheDocument();
		expect(screen.queryByRole('combobox', { name: `Role for ${OWNER}` })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: `Remove ${OWNER}` })).not.toBeInTheDocument();

		expect(screen.getByRole('combobox', { name: `Role for ${EDITOR}` })).toHaveValue('editor');
		expect(screen.getByRole('button', { name: `Remove ${EDITOR}` })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /add member/i })).toBeInTheDocument();
	});

	it('POSTs the typed user id with the chosen role', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderDialog('admin');

		await user.type(screen.getByLabelText('User id'), 'u-new');
		await user.selectOptions(screen.getByRole('combobox', { name: 'New member role' }), 'viewer');
		await user.click(screen.getByRole('button', { name: /add member/i }));

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.url).toContain(`/projects/${PID}/members`);
			expect(post?.body).toEqual({ user_id: 'u-new', role: 'viewer' });
		});
	});

	it('PUTs a role change from the row select', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderDialog('admin');

		await user.selectOptions(screen.getByRole('combobox', { name: `Role for ${EDITOR}` }), 'admin');

		await waitFor(() => {
			const put = calls.find((c) => c.method === 'PUT');
			expect(put?.url).toContain(`/projects/${PID}/members/${EDITOR}`);
			expect(put?.body).toEqual({ role: 'admin' });
		});
	});

	it('removes a member only after the confirm dialog', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderDialog('admin');

		await user.click(screen.getByRole('button', { name: `Remove ${EDITOR}` }));
		expect(screen.getByText(/Remove "Eddie Editor" from "Sales"/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

		await user.click(screen.getByRole('button', { name: 'Remove' }));
		await waitFor(() => {
			const del = calls.find((c) => c.method === 'DELETE');
			expect(del?.url).toContain(`/projects/${PID}/members/${EDITOR}`);
		});
	});

	it('surfaces a 409 from add and keeps the dialog open', async () => {
		const user = userEvent.setup();
		makeFetch({ addResponse: conflict('User u-dup is already a member of project proj-1') });
		await renderDialog('admin');

		await user.type(screen.getByLabelText('User id'), 'u-dup');
		await user.click(screen.getByRole('button', { name: /add member/i }));

		expect(await screen.findByText(/already a member/)).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument();
	});
});

describe('ProjectMembersDialog — non-admin', () => {
	it('renders a read-only list: no role selects, no remove, no add form', async () => {
		makeFetch();
		await renderDialog('viewer');

		expect(screen.getByText('Olive Owner')).toBeInTheDocument();
		expect(screen.getByText('editor')).toBeInTheDocument();
		expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /add member/i })).not.toBeInTheDocument();
		expect(screen.queryByLabelText('User id')).not.toBeInTheDocument();
	});
});
