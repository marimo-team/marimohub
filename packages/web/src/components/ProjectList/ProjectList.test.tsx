import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectSummary } from '@/types';
import { ProjectList } from './ProjectList';

function project(name: string, description = ''): ProjectSummary {
	return {
		id: `proj-${name.toLowerCase()}`,
		name,
		description,
		owner: 'me',
		status: 'active',
		created_at: '2025-03-05T14:00:00Z',
		updated_at: '2025-03-05T14:00:00Z',
		notebook_count: 0,
	} as ProjectSummary;
}

/** Mount ProjectList with a router, query client, and a fetch returning `projects`. */
function renderList(projects: ProjectSummary[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ success: true, data: { items: projects, next_cursor: null } }),
					{
						headers: { 'content-type': 'application/json' },
					},
				),
		),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter>
			<QueryClientProvider client={client}>
				<Suspense fallback={<div>loading</div>}>{children}</Suspense>
			</QueryClientProvider>
		</MemoryRouter>
	);
	return render(<ProjectList />, { wrapper });
}

async function waitForLoaded() {
	await waitForElementToBeRemoved(() => screen.queryByText('loading'));
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

	it('filters the list by the search box (name or description)', async () => {
		const user = userEvent.setup();
		renderList([project('Sales', 'revenue'), project('Marketing', 'campaign analysis')]);
		await waitForLoaded();

		await user.type(screen.getByPlaceholderText('Search projects...'), 'analysis');

		expect(screen.getByText('Marketing')).toBeInTheDocument();
		expect(screen.queryByText('Sales')).not.toBeInTheDocument();
	});

	it('shows a "no matches" empty state when the search excludes everything', async () => {
		const user = userEvent.setup();
		renderList([project('Sales')]);
		await waitForLoaded();

		await user.type(screen.getByPlaceholderText('Search projects...'), 'zzz');

		expect(screen.getByText('No projects matching "zzz"')).toBeInTheDocument();
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
