import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagsInNamespace } from '@marimo-hub/core/tag-paths';
import { useLocation } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { userKeys } from '@/api/queryKeys';
import { createTestQueryClient, jsonOk, renderWithClient } from '@/test/render';
import type { ProjectSummary, User } from '@/types';
import { ProjectList } from './ProjectList';

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
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), 'http://localhost');
		const q = url.searchParams.get('q')?.toLocaleLowerCase();
		const tag = url.searchParams.get('tag');
		const namespace = url.searchParams.get('tag_namespace');
		const status = url.searchParams.get('status');
		const filtered = projects.filter(
			(entry) =>
				(status ? entry.status === status : entry.status !== 'deleted') &&
				(!tag || entry.tags.includes(tag)) &&
				(namespace === null || tagsInNamespace(entry.tags, namespace)) &&
				(!q || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(q)),
		);
		const start = Number(url.searchParams.get('cursor') ?? 0);
		const items = filtered.slice(start, start + pageSize);
		const next_cursor = start + pageSize < filtered.length ? String(start + pageSize) : null;
		return jsonOk({ items, next_cursor });
	});
	vi.stubGlobal('fetch', fetchMock);
	const client = createTestQueryClient();
	client.setQueryData(userKeys.me(), { id: 'me', can_create_projects: canCreateProjects } as User);
	return {
		...renderWithClient(
			<AuthProvider>
				<ProjectList />
				<Location />
			</AuthProvider>,
			{ client, route, toaster: false },
		),
		fetchMock,
	};
}

function Location() {
	return <span data-testid="location">{useLocation().search}</span>;
}

function requestsWithNamespace(
	fetchMock: ReturnType<typeof renderList>['fetchMock'],
	namespace: string | null,
) {
	return fetchMock.mock.calls
		.map(([input]) => new URL(String(input), 'http://localhost'))
		.filter((url) => url.searchParams.get('tag_namespace') === namespace);
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
	it.each(['', ' ', 'Research', 'research/', 'a'.repeat(257)])(
		'ignores an invalid namespace URL %j before requesting projects',
		async (prefix) => {
			const { fetchMock } = renderList(
				[project('Available')],
				`/?tag_namespace=${encodeURIComponent(prefix)}`,
			);
			await waitForLoaded();
			expect(screen.getByText('Available')).toBeInTheDocument();
			expect(
				screen.queryByRole('navigation', { name: 'Project namespace' }),
			).not.toBeInTheDocument();
			expect(
				new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost').searchParams.has(
					'tag_namespace',
				),
			).toBe(false);
		},
	);

	it('normalizes a copied namespace URL for both requests and breadcrumbs', async () => {
		const { fetchMock } = renderList(
			[project('Vision', '', { tags: ['research/vision'] }), project('Unrelated')],
			'/?tag_namespace=%20research%2Fvision%20',
		);
		await waitForLoaded();
		expect(screen.getByText('Vision')).toBeInTheDocument();
		expect(screen.queryByText('Unrelated')).not.toBeInTheDocument();
		const breadcrumb = screen.getByRole('navigation', { name: 'Project namespace' });
		expect(within(breadcrumb).getByRole('button', { name: 'vision' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		expect(
			new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost').searchParams.get(
				'tag_namespace',
			),
		).toBe('research/vision');
	});

	it('groups by default and remembers opting out without duplicating shared projects', async () => {
		const user = userEvent.setup();
		const projects = [project('Shared', '', { tags: ['ops', 'research'] })];
		const { unmount } = renderList(projects);
		await waitForLoaded();
		const toggle = screen.getByRole('button', { name: 'Group by namespace' });
		expect(toggle).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getAllByText('Shared')).toHaveLength(2);
		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getAllByText('Shared')).toHaveLength(1);
		unmount();
		renderList(projects);
		await waitForLoaded();
		expect(screen.getByRole('button', { name: 'Group by namespace' })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		expect(screen.queryByRole('region')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Group by namespace' }));
		expect(screen.getAllByText('Shared')).toHaveLength(2);
	});

	it.each([
		{ label: 'no projects', projects: [] },
		{ label: 'untagged projects', projects: [project('Loose')] },
		{
			label: 'only free-form tags',
			projects: [project('Loose', '', { tags: ['Team A', 'Research/X', 'ops/'] })],
		},
	])('hides namespace grouping with $label', async ({ projects }) => {
		renderList(projects);
		await waitForLoaded();
		expect(screen.queryByRole('button', { name: 'Group by namespace' })).not.toBeInTheDocument();
		expect(screen.queryByRole('region')).not.toBeInTheDocument();
		expect(screen.queryAllByTestId('project-row')).toHaveLength(projects.length);
		expect(screen.getByRole('status')).toHaveTextContent(`${projects.length} project`);
	});

	it('keeps namespace grouping available when a search matches only untagged projects', async () => {
		renderList(
			[project('Vision', '', { tags: ['research/vision'] }), project('Loose')],
			'/?q=loose',
		);
		await waitForLoaded();
		expect(screen.getByRole('status')).toHaveTextContent('1 project');
		expect(await screen.findByRole('button', { name: 'Group by namespace' })).toBeVisible();
	});

	it('keeps namespace grouping available when only deleted projects are namespaced', async () => {
		renderList(
			[
				project('Old Vision', '', { tags: ['research/vision'], status: 'deleted' }),
				project('Loose'),
			],
			'/?status=deleted',
		);
		await waitForLoaded();
		expect(screen.getByRole('status')).toHaveTextContent('1 project');
		expect(await screen.findByRole('button', { name: 'Group by namespace' })).toBeVisible();
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
		const toggle = screen.getByRole('button', { name: 'Group by namespace' });
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
			'/?tag_namespace=missing&tag=shared&q=annual&status=active',
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

	it.each(['/', '/?tag_namespace=scale'])(
		'drills down from a five-row preview at %s and shows all direct matches',
		async (route) => {
			const user = userEvent.setup();
			const tag = route === '/' ? 'scale' : 'scale/team';
			const { fetchMock } = renderList(scaleProjects(7, tag), route, true, 3);
			await waitForLoaded();
			const namespace = new URLSearchParams(route.slice(1)).get('tag_namespace');
			expect(requestsWithNamespace(fetchMock, namespace)).toHaveLength(3);
			expect(screen.getAllByTestId('project-row')).toHaveLength(5);
			await user.click(screen.getByRole('button', { name: 'Show all 7' }));
			await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(7));
			expect(screen.getByTestId('location')).toHaveTextContent(
				`tag_namespace=${encodeURIComponent(tag)}`,
			);
			expect(screen.getByRole('navigation', { name: 'Project namespace' })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Show all 7' })).not.toBeInTheDocument();
		},
	);

	it.each(['', 'ops/'])(
		'allows namespace links at the 256-character boundary under %j',
		async (parent) => {
			const user = userEvent.setup();
			const tag = parent + 'a'.repeat(256 - parent.length);
			renderList(scaleProjects(6, tag), parent ? '/?tag_namespace=ops' : '/');
			await waitForLoaded();
			expect(screen.getAllByTestId('project-row')).toHaveLength(5);
			await user.click(screen.getByRole('button', { name: 'Show all 6' }));
			await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(6));
			expect(
				new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('tag_namespace'),
			).toBe(tag);
		},
	);

	it('hides show-all when collapsed and shows every row when grouping is disabled', async () => {
		const user = userEvent.setup();
		renderList(scaleProjects(7));
		await waitForLoaded();
		await user.click(screen.getByRole('button', { name: 'Toggle scale' }));
		expect(screen.queryAllByTestId('project-row')).toHaveLength(0);
		expect(screen.queryByRole('button', { name: 'Show all 7' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Toggle scale' }));
		expect(screen.getAllByTestId('project-row')).toHaveLength(5);
		expect(screen.getByRole('button', { name: 'Show all 7' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Group by namespace' }));
		expect(screen.getAllByTestId('project-row')).toHaveLength(7);
		expect(screen.queryByRole('button', { name: 'Show all 7' })).not.toBeInTheDocument();
	});

	it('collapses Ungrouped independently from a namespace named ungrouped', async () => {
		const user = userEvent.setup();
		renderList([
			project('Tagged', '', { tags: ['ungrouped'] }),
			...Array.from({ length: 7 }, (_, i) => project(`Loose ${i}`)),
		]);
		await waitForLoaded();
		const ungrouped = screen.getByRole('region', { name: 'Ungrouped · 7' });
		const toggle = within(ungrouped).getByRole('button', { name: 'Toggle Ungrouped' });
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		const controlled = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
		expect(within(controlled!).getAllByTestId('project-row')).toHaveLength(7);

		await user.click(within(ungrouped).getByRole('button', { name: 'Toggle Ungrouped' }));
		expect(within(ungrouped).queryAllByTestId('project-row')).toHaveLength(0);
		expect(within(ungrouped).getByRole('button', { name: 'Toggle Ungrouped' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		expect(screen.getByText('Tagged')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Toggle ungrouped' }));
		await user.click(within(ungrouped).getByRole('button', { name: 'Toggle Ungrouped' }));
		expect(within(ungrouped).getAllByTestId('project-row')).toHaveLength(7);
		expect(screen.queryByText('Tagged')).not.toBeInTheDocument();
	});

	it('shows direct matches under the breadcrumb without a redundant heading', async () => {
		renderList([project('Operations', '', { tags: ['ops'] })], '/?tag_namespace=ops');
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
		await user.click(screen.getByRole('button', { name: 'Toggle research' }));
		expect(screen.queryByText('Vision')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Toggle research' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		await user.click(screen.getByRole('button', { name: 'research · 2' }));
		await waitFor(() => expect(screen.queryByText('Neighbor')).not.toBeInTheDocument());
		expect(screen.getByTestId('location')).toHaveTextContent('tag_namespace=research');
		expect(String(fetchMock.mock.lastCall?.[0])).toContain('tag_namespace=research');
		await user.click(screen.getByRole('button', { name: 'vision · 1' }));
		await waitFor(() => expect(screen.queryByText('Language')).not.toBeInTheDocument());
		expect(screen.getByTestId('location')).toHaveTextContent('tag_namespace=research%2Fvision');
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
			'/?tag_namespace=research&tag=shared&q=match&status=active',
			true,
			1,
		);
		await waitForLoaded();
		expect(screen.getAllByText('First')).toHaveLength(2);
		expect(screen.getByText('Second')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('2 projects');
		const pages = requestsWithNamespace(fetchMock, 'research');
		expect(pages).toHaveLength(2);
		for (const url of pages) {
			expect(Object.fromEntries(url.searchParams)).toMatchObject({
				tag_namespace: 'research',
				tag: 'shared',
				q: 'match',
				status: 'active',
				limit: '500',
			});
		}
		expect(pages[1].searchParams.get('cursor')).toBe('1');
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
