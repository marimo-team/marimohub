import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagsMatchPrefix } from '@marimo-hub/core/tag-paths';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectSummary } from '@/types';
import { ProjectList } from './ProjectList';

const authState = vi.hoisted(() => ({ canCreateProjects: true as boolean | undefined }));

vi.mock('@/context/AuthContext', () => ({
	useAuth: () => ({ user: { can_create_projects: authState.canCreateProjects } }),
}));

type TestProject = ProjectSummary;

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

function scaleProjects(count: number, tag = 'scale') {
	return Array.from({ length: count }, (_, i) => project(`Scale ${i}`, '', { tags: [tag] }));
}

function renderList(
	projects: TestProject[],
	route = '/',
	canCreateProjects: boolean | undefined = true,
	pageSize = 500,
) {
	authState.canCreateProjects = canCreateProjects;
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), 'http://localhost');
		const q = url.searchParams.get('q')?.toLocaleLowerCase();
		const tag = url.searchParams.get('tag');
		const prefix = url.searchParams.get('tag_prefix');
		const status = url.searchParams.get('status');
		const filtered = projects.filter(
			(entry) =>
				(status ? entry.status === status : entry.status !== 'deleted') &&
				(!tag || entry.tags.includes(tag)) &&
				(prefix === null || tagsMatchPrefix(entry.tags, prefix)) &&
				(!q || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(q)),
		);
		const start = Number(url.searchParams.get('cursor') ?? 0);
		const items = filtered.slice(start, start + pageSize);
		const next_cursor = start + pageSize < filtered.length ? String(start + pageSize) : null;
		return new Response(JSON.stringify({ success: true, data: { items, next_cursor } }), {
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
	return {
		...render(
			<>
				<ProjectList />
				<Location />
			</>,
			{ wrapper },
		),
		fetchMock,
	};
}

function Location() {
	return <span data-testid="location">{useLocation().search}</span>;
}

async function waitForLoaded() {
	await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Loading'));
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.removeItem('project-group-by-tags');
});

describe('ProjectList', () => {
	it('groups by default and remembers opting out without duplicating shared projects', async () => {
		const user = userEvent.setup();
		const projects = [project('Shared', '', { tags: ['ops', 'research'] })];
		const { unmount } = renderList(projects);
		await waitForLoaded();
		const toggle = screen.getByRole('button', { name: 'Group by tags' });
		expect(toggle).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getAllByText('Shared')).toHaveLength(2);
		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getAllByText('Shared')).toHaveLength(1);
		unmount();
		renderList(projects);
		await waitForLoaded();
		expect(screen.getByRole('button', { name: 'Group by tags' })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		expect(screen.queryByRole('region')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Group by tags' }));
		expect(screen.getAllByText('Shared')).toHaveLength(2);
	});

	it.each([
		{ label: 'no projects', projects: [] },
		{ label: 'untagged projects', projects: [project('Loose')] },
		{
			label: 'only free-form tags',
			projects: [project('Loose', '', { tags: ['Team A', 'Research/X', 'ops/'] })],
		},
	])('keeps a flat list with $label when grouping is toggled', async ({ projects }) => {
		const user = userEvent.setup();
		renderList(projects);
		await waitForLoaded();
		const toggle = screen.getByRole('button', { name: 'Group by tags' });
		for (let i = 0; i < 2; i++) {
			expect(screen.queryByRole('region')).not.toBeInTheDocument();
			expect(screen.queryAllByTestId('project-row')).toHaveLength(projects.length);
			await user.click(toggle);
		}
		expect(screen.getByRole('status')).toHaveTextContent(`${projects.length} project`);
	});

	it('still groups and toggles when browser storage is unavailable', async () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new DOMException('Storage disabled', 'SecurityError');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('Storage disabled', 'SecurityError');
		});
		const user = userEvent.setup();
		renderList([project('Shared', '', { tags: ['ops', 'research'] })]);
		await waitForLoaded();
		const toggle = screen.getByRole('button', { name: 'Group by tags' });
		expect(toggle).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getAllByText('Shared')).toHaveLength(2);
		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getAllByText('Shared')).toHaveLength(1);
	});

	it('can leave an empty namespace without clearing the other filters', async () => {
		const user = userEvent.setup();
		renderList(
			[
				project('Sales', 'annual report', { tags: ['finance', 'shared'] }),
				project('Hidden', 'annual report', { tags: ['finance'] }),
			],
			'/?tag_prefix=missing&tag=shared&q=annual&status=active',
		);
		await waitForLoaded();
		expect(screen.getByText('No projects match these filters')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'All projects' }));
		expect(await screen.findAllByText('Sales')).toHaveLength(2);
		expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
		const params = new URLSearchParams(screen.getByTestId('location').textContent ?? '');
		expect(Object.fromEntries(params)).toEqual({ tag: 'shared', q: 'annual', status: 'active' });
	});

	it.each([5, 6])(
		'previews at most five of %i projects and only offers show-all when needed',
		async (count) => {
			renderList(scaleProjects(count));
			await waitForLoaded();
			const group = screen.getByRole('region', { name: `scale · ${count}` });
			expect(within(group).getAllByTestId('project-row')).toHaveLength(5);
			expect(screen.queryByText('Scale 5')).not.toBeInTheDocument();
			expect(within(group).queryAllByRole('button', { name: `Show all ${count}` })).toHaveLength(
				count > 5 ? 1 : 0,
			);
			expect(screen.getByRole('status')).toHaveTextContent(`${count} projects`);
		},
	);

	it.each(['/', '/?tag_prefix=scale'])(
		'drills down from a five-row preview at %s and shows all direct matches',
		async (route) => {
			const user = userEvent.setup();
			const tag = route === '/' ? 'scale' : 'scale/team';
			const { fetchMock } = renderList(scaleProjects(7, tag), route, true, 3);
			await waitForLoaded();
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(screen.getAllByTestId('project-row')).toHaveLength(5);
			await user.click(screen.getByRole('button', { name: 'Show all 7' }));
			await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(7));
			expect(screen.getByTestId('location')).toHaveTextContent(
				`tag_prefix=${encodeURIComponent(tag)}`,
			);
			expect(screen.getByRole('navigation', { name: 'Project namespace' })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Show all 7' })).not.toBeInTheDocument();
		},
	);

	it.each(['', 'ops/'])(
		'keeps oversized groups accessible without invalid links under %j',
		async (parent) => {
			const user = userEvent.setup();
			const label = 'a'.repeat(257 - parent.length);
			const route = parent ? '/?tag_prefix=ops' : '/';
			const { fetchMock } = renderList(scaleProjects(6, `${parent}${label}`), route);
			await waitForLoaded();
			const group = screen.getByRole('region', { name: `${label} · 6` });
			expect(within(group).queryByRole('button', { name: `${label} · 6` })).not.toBeInTheDocument();
			expect(within(group).queryByRole('button', { name: 'Show all 6' })).not.toBeInTheDocument();
			expect(within(group).getAllByTestId('project-row')).toHaveLength(6);
			expect(within(group).getByRole('link', { name: /Scale 5/ })).toHaveAttribute(
				'href',
				'/projects/proj-scale 5',
			);
			await user.click(within(group).getByRole('button', { name: `Collapse ${label}` }));
			expect(within(group).queryAllByTestId('project-row')).toHaveLength(0);
			await user.click(within(group).getByRole('button', { name: `Expand ${label}` }));
			expect(within(group).getAllByTestId('project-row')).toHaveLength(6);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it.each(['', 'ops/'])(
		'allows namespace links at the 256-character boundary under %j',
		async (parent) => {
			const user = userEvent.setup();
			const tag = parent + 'a'.repeat(256 - parent.length);
			renderList(scaleProjects(6, tag), parent ? '/?tag_prefix=ops' : '/');
			await waitForLoaded();
			expect(screen.getAllByTestId('project-row')).toHaveLength(5);
			await user.click(screen.getByRole('button', { name: 'Show all 6' }));
			await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(6));
			expect(
				new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('tag_prefix'),
			).toBe(tag);
		},
	);

	it('hides show-all when collapsed and shows every row when grouping is disabled', async () => {
		const user = userEvent.setup();
		renderList(scaleProjects(7));
		await waitForLoaded();
		await user.click(screen.getByRole('button', { name: 'Collapse scale' }));
		expect(screen.queryAllByTestId('project-row')).toHaveLength(0);
		expect(screen.queryByRole('button', { name: 'Show all 7' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Expand scale' }));
		expect(screen.getAllByTestId('project-row')).toHaveLength(5);
		expect(screen.getByRole('button', { name: 'Show all 7' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Group by tags' }));
		expect(screen.getAllByTestId('project-row')).toHaveLength(7);
		expect(screen.queryByRole('button', { name: 'Show all 7' })).not.toBeInTheDocument();
	});

	it('keeps all ungrouped projects reachable without a namespace to drill into', async () => {
		renderList([
			project('Tagged', '', { tags: ['ops'] }),
			...Array.from({ length: 7 }, (_, i) => project(`Loose ${i}`)),
		]);
		await waitForLoaded();
		expect(
			within(screen.getByRole('region', { name: 'Ungrouped · 7' })).getAllByTestId('project-row'),
		).toHaveLength(7);
	});

	it('shows direct matches under the breadcrumb without a redundant heading', async () => {
		renderList([project('Operations', '', { tags: ['ops'] })], '/?tag_prefix=ops');
		await waitForLoaded();
		expect(screen.getByRole('navigation', { name: 'Project namespace' })).toBeInTheDocument();
		expect(screen.getByText('Operations')).toBeInTheDocument();
		expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
	});

	it('renders groups and tags, collapses rows, and drills down with breadcrumbs', async () => {
		const user = userEvent.setup();
		const { fetchMock } = renderList([
			project('Vision', '', { tags: ['research/vision/seg'] }),
			project('Language', '', { tags: ['research/nlp'] }),
			project('Neighbor', '', { tags: ['research10'] }),
			project('Loose'),
		]);
		await waitForLoaded();
		expect(screen.getByText('research/vision/seg')).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Ungrouped · 1' })).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('4 projects');
		await user.click(screen.getByRole('button', { name: 'Collapse research' }));
		expect(screen.queryByText('Vision')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Expand research' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		await user.click(screen.getByRole('button', { name: 'research · 2' }));
		await waitFor(() => expect(screen.queryByText('Neighbor')).not.toBeInTheDocument());
		expect(screen.getByTestId('location')).toHaveTextContent('tag_prefix=research');
		expect(String(fetchMock.mock.lastCall?.[0])).toContain('tag_prefix=research');
		await user.click(screen.getByRole('button', { name: 'vision · 1' }));
		await waitFor(() => expect(screen.queryByText('Language')).not.toBeInTheDocument());
		expect(screen.getByTestId('location')).toHaveTextContent('tag_prefix=research%2Fvision');
		await user.click(screen.getByRole('button', { name: 'research' }));
		expect(await screen.findByText('Language')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'All projects' }));
		expect(await screen.findByText('Neighbor')).toBeInTheDocument();
		expect(screen.getByTestId('location')).toBeEmptyDOMElement();
	});

	it('fetches all pages with the same filters and counts shared projects once', async () => {
		const { fetchMock } = renderList(
			[
				project('First', 'match', { tags: ['research/vision', 'research/nlp', 'shared'] }),
				project('Second', 'match', { tags: ['research/vision', 'shared'] }),
			],
			'/?tag_prefix=research&tag=shared&q=match&status=active',
			true,
			1,
		);
		await waitForLoaded();
		expect(screen.getAllByText('First')).toHaveLength(2);
		expect(screen.getByText('Second')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('2 projects');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [input] of fetchMock.mock.calls) {
			const params = new URL(String(input), 'http://localhost').searchParams;
			expect(Object.fromEntries(params)).toMatchObject({
				tag_prefix: 'research',
				tag: 'shared',
				q: 'match',
				status: 'active',
				limit: '500',
			});
		}
		expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=1');
	});

	it('renders the fetched projects', async () => {
		renderList([project('Sales'), project('Marketing')]);
		await waitForLoaded();

		expect(document.title).toBe('Projects · marimohub');
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(screen.getByText('Marketing')).toBeInTheDocument();
		expect(screen.queryByRole('region')).not.toBeInTheDocument();
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

	it('hides project-creation actions when the server denies access', async () => {
		renderList([], '/', false);
		await waitForLoaded();

		expect(screen.queryByRole('button', { name: 'New Project' })).not.toBeInTheDocument();
		expect(
			screen.queryByRole('button', { name: 'Create your first project' }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Create New Project' })).not.toBeInTheDocument();
	});

	it('keeps project creation available with an older user response', async () => {
		renderList([], '/', undefined);
		await waitForLoaded();

		expect(screen.getByRole('button', { name: 'New Project' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create your first project' })).toBeInTheDocument();
	});

	it('filters the list by name or description after submission', async () => {
		const user = userEvent.setup();
		renderList([project('Sales', 'revenue'), project('Marketing', 'campaign analysis')]);
		await waitForLoaded();

		await user.click(screen.getByRole('button', { name: 'Filters' }));
		await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'analysis{Enter}');

		await waitFor(() => expect(screen.getByText('Marketing')).toBeInTheDocument());
		expect(screen.queryByText('Sales')).not.toBeInTheDocument();
	});

	it('shows a reset action when filters exclude everything', async () => {
		const user = userEvent.setup();
		renderList([project('Sales')]);
		await waitForLoaded();

		await user.click(screen.getByRole('button', { name: 'Filters' }));
		await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzz');
		await user.click(screen.getByRole('button', { name: 'Apply' }));

		expect(await screen.findByText('No projects match these filters')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Reset filters' }));
		expect(await screen.findByText('Sales')).toBeInTheDocument();
	});

	it('opens the filters and focuses search with the search shortcut', async () => {
		const user = userEvent.setup();
		renderList([project('Sales')]);
		await waitForLoaded();

		await user.keyboard('/');

		await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveFocus());
	});

	it('provides labeled controls and announces the result count', async () => {
		const user = userEvent.setup();
		renderList([project('Sales')]);
		await waitForLoaded();

		const toggle = screen.getByRole('button', { name: 'Filters' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('search', { name: 'Filter projects' })).not.toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('1 project');

		await user.click(toggle);
		expect(screen.getByRole('search', { name: 'Filter projects' })).toBeInTheDocument();
		expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: 'Exact tag' })).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();

		await user.click(toggle);
		expect(screen.queryByRole('search', { name: 'Filter projects' })).not.toBeInTheDocument();
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

		expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute(
			'aria-expanded',
			'true',
		);
		expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('analysis');
		expect(screen.getByRole('textbox', { name: 'Exact tag' })).toHaveValue('finance');
		expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('active');
		expect(screen.getByText('Sales')).toBeInTheDocument();
		expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
		const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost');
		expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
			limit: '500',
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
