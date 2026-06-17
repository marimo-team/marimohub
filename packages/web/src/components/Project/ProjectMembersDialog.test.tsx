import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ProjectMembersDialog } from './ProjectMembersDialog';
import type { Capabilities, ProjectDetail, ProjectMember, ResolvedUser } from '@/types';

const PID = 'proj-1';
const OWNER = 'u-owner';
const EDITOR = 'u-edit';
const INVITED = 'pending@x.io';

const project = (yourRole: ProjectDetail['your_role']): ProjectDetail =>
	({ id: PID, name: 'Sales', owner: OWNER, your_role: yourRole }) as ProjectDetail;

const MEMBERS: ProjectMember[] = [
	{ user_id: OWNER, role: 'admin' },
	{ user_id: EDITOR, role: 'editor' },
	{ email: INVITED, role: 'viewer' },
];

const DIRECTORY = {
	[OWNER]: { id: OWNER, email: 'olive@x.io', name: 'Olive Owner' },
	[EDITOR]: { id: EDITOR, email: 'eddie@x.io', name: 'Eddie Editor' },
};

const NINA: ResolvedUser = { id: 'u-nina', email: 'nina@x.io', name: 'Nina New' };

const CAPABILITIES = {
	federation: { available: false },
	viewer_mode: 'static',
	default_role: null,
} as unknown as Capabilities;

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
function makeFetch({
	addResponse,
	searchResults = [NINA],
	capabilities = CAPABILITIES,
}: {
	addResponse?: Response;
	searchResults?: ResolvedUser[];
	capabilities?: Capabilities;
} = {}) {
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
		if (url.includes('/capabilities')) return ok(capabilities);
		if (url.includes('/users/search')) return ok(searchResults);
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

/** Type into the picker and click the option it surfaces (debounced search). */
async function pickOption(user: ReturnType<typeof userEvent.setup>, query: string, option: RegExp) {
	await user.type(screen.getByRole('combobox', { name: 'Search users' }), query);
	await user.click(await screen.findByRole('option', { name: option }));
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
		expect(screen.getByRole('combobox', { name: 'Search users' })).toBeInTheDocument();
	});

	it('renders a pending email invite with its badge and controls', async () => {
		makeFetch();
		await renderDialog('admin');

		expect(screen.getByText(INVITED)).toBeInTheDocument();
		expect(screen.getByText('invited')).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: `Role for ${INVITED}` })).toHaveValue('viewer');
	});

	it('POSTs the picked search result by user id with the chosen role', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderDialog('admin');

		await user.selectOptions(screen.getByRole('combobox', { name: 'New member role' }), 'viewer');
		await pickOption(user, 'nina', /Nina New/);

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.url).toContain(`/projects/${PID}/members`);
			expect(post?.body).toEqual({ user_id: NINA.id, role: 'viewer' });
		});
	});

	it('POSTs an email invite when the query is an unknown email', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ searchResults: [] });
		await renderDialog('admin');

		await pickOption(user, 'Newbie@x.io', /Invite "newbie@x\.io" by email/);

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.body).toEqual({ email: 'newbie@x.io', role: 'editor' });
		});
	});

	it('POSTs a raw user id via the fallback option when search misses', async () => {
		const user = userEvent.setup();
		const calls = makeFetch({ searchResults: [] });
		await renderDialog('admin');

		await pickOption(user, 'u-raw', /Add "u-raw" by user id/);

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post?.body).toEqual({ user_id: 'u-raw', role: 'editor' });
		});
	});

	it('offers the raw-id fallback below results, so substring hits do not block an exact id', async () => {
		const user = userEvent.setup();
		makeFetch(); // search returns Nina for any query
		await renderDialog('admin');

		await user.type(screen.getByRole('combobox', { name: 'Search users' }), 'u-raw');
		expect(
			await screen.findByRole('option', { name: /Add "u-raw" by user id/ }),
		).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Nina New/ })).toBeInTheDocument();
	});

	it('never offers the raw-id fallback for an id the directory already knows', async () => {
		const user = userEvent.setup();
		makeFetch(); // NINA.id === 'u-nina'
		await renderDialog('admin');

		await user.type(screen.getByRole('combobox', { name: 'Search users' }), NINA.id);
		await screen.findByRole('option', { name: /Nina New/ });
		expect(screen.queryByRole('option', { name: /by user id/ })).not.toBeInTheDocument();
	});

	it('offers no fallback while the query is too short to search', async () => {
		const user = userEvent.setup();
		makeFetch({ searchResults: [] });
		await renderDialog('admin');

		await user.type(screen.getByRole('combobox', { name: 'Search users' }), 'u');
		expect(await screen.findByText('Type at least two characters to search')).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /by user id|Invite/ })).not.toBeInTheDocument();
	});

	it("does not offer inviting an existing member's resolved email", async () => {
		const user = userEvent.setup();
		makeFetch({ searchResults: [] });
		await renderDialog('admin');

		// eddie@x.io belongs to the member u-edit via the directory resolution.
		await user.type(screen.getByRole('combobox', { name: 'Search users' }), 'eddie@x.io');
		expect(await screen.findByText('No matching users')).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Invite/ })).not.toBeInTheDocument();
	});

	it('does not offer inviting a syntactically invalid email as an email', async () => {
		const user = userEvent.setup();
		makeFetch({ searchResults: [] });
		await renderDialog('admin');

		// Rejected by the same validator the server uses (would 422 there); the
		// free-text id fallback still applies.
		await user.type(screen.getByRole('combobox', { name: 'Search users' }), 'a@b@c.com');
		expect(await screen.findByRole('option', { name: /by user id/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Invite/ })).not.toBeInTheDocument();
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

	it('removes a pending invite by its URL-encoded email', async () => {
		const user = userEvent.setup();
		const calls = makeFetch();
		await renderDialog('admin');

		await user.click(screen.getByRole('button', { name: `Remove ${INVITED}` }));
		await user.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(() => {
			const del = calls.find((c) => c.method === 'DELETE');
			expect(del?.url).toContain(`/projects/${PID}/members/${encodeURIComponent(INVITED)}`);
		});
	});

	it('surfaces a 409 from add and keeps the dialog open', async () => {
		const user = userEvent.setup();
		makeFetch({
			searchResults: [],
			addResponse: conflict('u-dup is already a member of project proj-1'),
		});
		await renderDialog('admin');

		await pickOption(user, 'u-dup', /Add "u-dup" by user id/);

		expect(await screen.findByText(/already a member/)).toBeInTheDocument();
		expect(screen.getByRole('dialog', { name: 'Members' })).toBeInTheDocument();
	});

	it('describes a members-only deployment (default_role null)', async () => {
		makeFetch();
		await renderDialog('admin');
		expect(await screen.findByText(/members-only/)).toBeInTheDocument();
	});

	it('describes an open deployment (default_role editor)', async () => {
		makeFetch({ capabilities: { ...CAPABILITIES, default_role: 'editor' } as Capabilities });
		await renderDialog('admin');
		expect(await screen.findByText(/Everyone who signs in can edit/)).toBeInTheDocument();
	});
});

describe('ProjectMembersDialog — non-admin', () => {
	it('renders a read-only list: no role selects, no remove, no add picker', async () => {
		makeFetch();
		await renderDialog('viewer');

		expect(screen.getByText('Olive Owner')).toBeInTheDocument();
		expect(screen.getByText('editor')).toBeInTheDocument();
		expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
	});
});
