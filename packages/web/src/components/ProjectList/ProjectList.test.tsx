import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectSummary } from '@/types';
import { ProjectList } from './ProjectList';

type TestProject = ProjectSummary & { tags: string[] };

function project(
	name: string,
	description = '',
	options: { status?: ProjectSummary['status']; tags?: string[] } = {},
): TestProject {
	return {
		id: `proj-${name.toLowerCase()}`,
		name,
		description,
		owner: 'me',
		status: options.status ?? 'active',
		tags: options.tags ?? [],
		created_at: '2025-03-05T14:00:00Z',
		updated_at: '2025-03-05T14:00:00Z',
		notebook_count: 0,
	} as TestProject;
}

function renderList(projects: TestProject[], route = '/') {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), 'http://localhost');
		const q = url.searchParams.get('q')?.toLocaleLowerCase();
		const tag = url.searchParams.get('tag');
		const status = url.searchParams.get('status');
		const items = projects.filter(
			(entry) =>
				(status ? entry.status === status : entry.status !== 'deleted') &&
				(!tag || entry.tags.includes(tag)) &&
				(!q || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(q)),
		);
		return new Response(JSON.stringify({ success: true, data: { items, next_cursor: null } }), {
			headers: { 'content-type': 'application/json' },
		});
	});
	vi.stubGlobal('fetch', fetchMock);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[route]}>
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
	return { ...render(<ProjectList />, { wrapper }), fetchMock };
}

async function waitForLoaded() {
	await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Loading'));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ProjectList', () => {
	it('renders the fetched projects', async () => {
		renderList([project('Sales'), project('Marketing')]);
		await waitForLoaded();

		expect(document.title).toBe('Projects · marimohub');
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(screen.getByText('Marketing')).toBeInTheDocument();
	});

	it('renders each project as a real link (cmd/middle-click can open a new tab)', async () => {
		renderList([project('Sales')]);
		await waitForLoaded();

		expect(screen.getByRole('link', { name: /Sales/ })).toHaveAttribute(
			'href',
			'/projects/proj-sales',
		);
	});

	it('shows the empty state when there are no projects', async () => {
		renderList([]);
		await waitForLoaded();

		expect(screen.getByText('No projects yet')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create your first project' })).toBeInTheDocument();
	});

	it('filters the list by name or description after submission', async () => {
		const user = userEvent.setup();
		renderList([project('Sales', 'revenue'), project('Marketing', 'campaign analysis')]);
		await waitForLoaded();

		await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'analysis{Enter}');

		await waitFor(() => expect(screen.getByText('Marketing')).toBeInTheDocument());
		expect(screen.queryByText('Sales')).not.toBeInTheDocument();
	});

	it('shows a reset action when filters exclude everything', async () => {
		const user = userEvent.setup();
		renderList([project('Sales')]);
		await waitForLoaded();

		await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzz');
		await user.click(screen.getByRole('button', { name: 'Apply Filters' }));

		expect(await screen.findByText('No projects match these filters')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Reset filters' }));
		expect(await screen.findByText('Sales')).toBeInTheDocument();
	});

	it('provides labeled controls and announces the result count', async () => {
		renderList([project('Sales')]);
		await waitForLoaded();

		expect(screen.getByRole('search', { name: 'Filter projects' })).toBeInTheDocument();
		expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: 'Tag (exact)' })).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('1 project');
	});

	it('loads combined filters from the URL and sends them to the API', async () => {
		const { fetchMock } = renderList(
			[
				project('Sales', 'annual analysis', { tags: ['finance'] }),
				project('Marketing', 'annual analysis', { tags: ['campaigns'] }),
			],
			'/?q=analysis&tag=finance&status=active',
		);
		await waitForLoaded();

		expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('analysis');
		expect(screen.getByRole('textbox', { name: 'Tag (exact)' })).toHaveValue('finance');
		expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('active');
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
		const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost');
		expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
			q: 'analysis',
			tag: 'finance',
			status: 'active',
		});
	});

	it('ignores an invalid status from a copied URL', async () => {
		const { fetchMock } = renderList([project('Sales')], '/?status=unknown&q=sales');
		await waitForLoaded();

		expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
		expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('status=');
		expect(screen.getByText('Sales')).toBeInTheDocument();
	});

	it('shows deleted projects without a link to an unavailable detail page', async () => {
		renderList([project('Old Sales', '', { status: 'deleted' })], '/?status=deleted');
		await waitForLoaded();

		expect(screen.getByTestId('project-row')).toHaveTextContent('Deleted');
		expect(screen.queryByRole('link', { name: /Old Sales/ })).not.toBeInTheDocument();
	});

	it('opens the create-project dialog from the header button', async () => {
		const user = userEvent.setup();
		renderList([project('Sales')]);
		await waitForLoaded();

		await user.click(screen.getByRole('button', { name: 'New Project' }));

		expect(screen.getByRole('heading', { name: 'Create New Project' })).toBeInTheDocument();
		expect(screen.getByLabelText('Project Name')).toBeInTheDocument();
	});
});
