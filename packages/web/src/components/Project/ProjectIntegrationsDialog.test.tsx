import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { OrgIntegrationsDialog, ProjectIntegrationsPanel } from './ProjectIntegrationsDialog';
import type { IntegrationDetail, IntegrationEntry, IntegrationKind, ProjectDetail } from '@/types';

const PID = 'p_1';

const awsSecretSource = {
	backend: 'aws-sm',
	title: 'AWS Secrets Manager',
	locator_placeholder: 'Secret ID or ARN, optionally followed by #json-key',
	locator_help: 'Use secret-id-or-arn[#json-key].',
};

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
	({ id: PID, name: 'Demo', your_role: 'admin', ...over }) as ProjectDetail;

const postgresKind: IntegrationKind = {
	kind: 'postgres',
	title: 'Postgres',
	description: 'A postgres database',
	category: 'database',
	brand: { icon: 'postgresql', color: '#4169E1' },
	schema_version: 1,
	json_schema: {
		type: 'object',
		required: ['host'],
		properties: { host: { type: 'string' } },
	},
	ui_hints: {},
	supports_test: false,
	requirements: ['sqlalchemy>=2'],
	secret_sources: { inline: false, references: [] },
};

const customEnvKind: IntegrationKind = {
	kind: 'custom_env',
	title: 'Custom env vars',
	description: 'Arbitrary env vars injected into every session',
	category: 'other',
	brand: { color: '#64748B' },
	schema_version: 1,
	json_schema: { type: 'object', properties: {} },
	ui_hints: {},
	supports_test: true,
	requirements: [],
	secret_sources: { inline: false, references: [] },
};

const secretKind: IntegrationKind = {
	...postgresKind,
	secret_sources: {
		inline: true,
		references: [awsSecretSource],
	},
	json_schema: {
		type: 'object',
		required: ['host', 'password'],
		properties: {
			host: { type: 'string' },
			password: {
				type: 'string',
				minLength: 1,
				'x-marimohub-secret': true,
			},
		},
	},
};

const clickhouseKind: IntegrationKind = {
	...postgresKind,
	kind: 'clickhouse',
	title: 'ClickHouse',
	secret_sources: { inline: false, references: [] },
	json_schema: {
		type: 'object',
		required: ['host'],
		properties: {
			host: { type: 'string' },
			port: { type: 'integer', default: 8443 },
			secure: { type: 'boolean', default: true },
			verify: { type: 'boolean', default: true },
			database: { type: 'string', default: 'default' },
			username: { type: 'string', default: 'default' },
			password: {
				type: 'string',
				minLength: 1,
				'x-marimohub-secret': true,
			},
		},
	},
};

const entry = (over: Partial<IntegrationEntry> = {}): IntegrationEntry => ({
	id: 'i_1',
	kind: 'postgres',
	name: 'prod-db',
	enabled: true,
	current_version: 1,
	created_by: 'u',
	created_at: '',
	updated_at: '',
	...over,
	scope: over.scope ?? 'project',
});

function ok(data: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify({ success: true, data }), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

function notFound() {
	return new Response(
		JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'disabled' } }),
		{ status: 404, headers: { 'content-type': 'application/json' } },
	);
}

function serverError() {
	return new Response(
		JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'boom' } }),
		{ status: 500, headers: { 'content-type': 'application/json' } },
	);
}

interface FetchOpts {
	kinds: IntegrationKind[] | null | 'error';
	entries: IntegrationEntry[] | null | 'error';
	details?: Record<string, IntegrationDetail>;
	patchError?: boolean;
	orgEntries?: IntegrationEntry[];
	/** A second project offered by the copy picker. */
	sourceProject?: { id: string; name: string; your_role: string; entries: IntegrationEntry[] };
	/** Serve the source project on a SECOND /projects page. */
	pagedProjects?: boolean;
	/** Every /projects page repeats the same next_cursor (a paging bug). */
	loopingProjects?: boolean;
	/** Delay the source project's detail (role) response. */
	slowRole?: boolean;
}

/** Routes the dialog's list, detail, and probe requests through one mock. */
function makeFetch({
	kinds,
	entries,
	details = {},
	patchError = false,
	orgEntries = [],
	sourceProject,
	pagedProjects = false,
	loopingProjects = false,
	slowRole = false,
}: FetchOpts) {
	const calls: {
		url: string;
		method: string;
		body: unknown;
		headers: Record<string, string>;
	}[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body
			? (JSON.parse(init.body as string) as Record<string, unknown>)
			: undefined;
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (method !== 'GET') calls.push({ url, method, body, headers });

		if (url.includes('/api/v1/integrations/kinds')) {
			if (kinds === 'error') return serverError();
			return kinds === null ? notFound() : ok(kinds);
		}
		if (url.includes('/api/v1/org/integrations')) {
			if (method === 'GET') return ok({ items: orgEntries, next_cursor: null });
			if (method === 'POST' && !url.includes('/test')) {
				return ok(
					{
						id: 'org_new',
						kind: body?.kind,
						name: body?.name,
						config: body?.config,
						enabled: true,
						current_version: 1,
						created_by: 'u',
						created_at: '',
						updated_at: '',
						scope: 'org',
					},
					201,
				);
			}
		}
		if (url.includes(`/projects/${PID}/integrations/test`) && method === 'POST') {
			return ok({ ok: true, latency_ms: 5 });
		}
		if (
			(url.endsWith('/api/v1/projects') || url.includes('/api/v1/projects?')) &&
			method === 'GET'
		) {
			if (loopingProjects) {
				return ok({ items: [{ id: PID, name: 'Demo' }], next_cursor: 'stuck' });
			}
			if (pagedProjects && sourceProject) {
				return url.includes('cursor=')
					? ok({
							items: [{ id: sourceProject.id, name: sourceProject.name }],
							next_cursor: null,
						})
					: ok({ items: [{ id: PID, name: 'Demo' }], next_cursor: 'page-2' });
			}
			const items = [
				{ id: PID, name: 'Demo' },
				...(sourceProject ? [{ id: sourceProject.id, name: sourceProject.name }] : []),
			];
			return ok({ items, next_cursor: null });
		}
		if (sourceProject && url.endsWith(`/projects/${sourceProject.id}`) && method === 'GET') {
			if (slowRole) await new Promise((resolve) => setTimeout(resolve, 50));
			return ok({
				id: sourceProject.id,
				name: sourceProject.name,
				your_role: sourceProject.your_role,
			});
		}
		if (sourceProject && url.includes(`/projects/${sourceProject.id}/integrations`)) {
			return ok({ items: sourceProject.entries, next_cursor: null });
		}
		if (url.includes(`/projects/${PID}/integrations/copy`) && method === 'POST') {
			return ok(
				{
					id: 'copied_1',
					kind: 'postgres',
					name: body?.name,
					enabled: true,
					current_version: 1,
					created_by: 'u',
					created_at: '',
					updated_at: '',
					config: {},
				},
				201,
			);
		}
		if (url.includes(`/projects/${PID}/integrations/`)) {
			const iid = url.split(`/projects/${PID}/integrations/`)[1];
			const detail = details[iid];
			if (method === 'GET') {
				return detail ? ok(detail, 200, { ETag: '"detail-version"' }) : notFound();
			}
			if (method === 'PATCH') return patchError ? serverError() : ok({ ...detail, ...body });
			if (method === 'DELETE') return ok(null);
		}
		if (url.includes(`/projects/${PID}/integrations`)) {
			if (method === 'GET') {
				if (entries === 'error') return serverError();
				return entries === null ? notFound() : ok({ items: entries, next_cursor: null });
			}
			if (method === 'POST') {
				return ok(
					{
						id: 'new_1',
						kind: body?.kind,
						name: body?.name,
						config: body?.config,
						enabled: true,
						current_version: 1,
						created_by: 'u',
						created_at: '',
						updated_at: '',
					},
					201,
				);
			}
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

function setup(
	overrides: Partial<React.ComponentProps<typeof ProjectIntegrationsPanel>> = {},
	fetchOpts: FetchOpts = { kinds: [postgresKind, customEnvKind], entries: [] },
) {
	const calls = makeFetch(fetchOpts);
	const onBack = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(<ProjectIntegrationsPanel project={project()} onBack={onBack} {...overrides} />, {
		wrapper,
	});
	return { onBack, calls };
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

afterEach(() => vi.unstubAllGlobals());

describe('ProjectIntegrationsPanel — disabled deployment', () => {
	it('shows a disabled message when the kinds/list routes 404', async () => {
		setup({}, { kinds: null, entries: null });
		expect(
			await screen.findByText('Integrations are not enabled on this deployment.'),
		).toBeInTheDocument();
	});
});

describe('ProjectIntegrationsPanel — query failures', () => {
	it('a failed kinds query shows an error instead of a permanent skeleton', async () => {
		setup({}, { kinds: 'error', entries: [] });
		expect(await screen.findByText(/Could not load integrations/)).toBeInTheDocument();
	});

	it('a failed list query shows an error instead of a permanent skeleton', async () => {
		setup({}, { kinds: [postgresKind], entries: 'error' });
		// The list query retries twice (only 404s skip retry) before surfacing.
		expect(
			await screen.findByText(/Could not load integrations/, undefined, { timeout: 8000 }),
		).toBeInTheDocument();
	}, 10_000);
});

describe('ProjectIntegrationsPanel — kind catalog', () => {
	it("shows each kind's declared notebook packages on its card", async () => {
		setup({}, { kinds: [postgresKind, customEnvKind], entries: [] });
		await userEvent.click(await screen.findByRole('button', { name: /Add integration/ }));
		expect(await screen.findByText(/Notebook packages:/)).toBeInTheDocument();
		expect(screen.getByText('sqlalchemy>=2')).toBeInTheDocument();
	});

	it('searches a catalog of 30 kinds by title', async () => {
		const user = userEvent.setup();
		const kinds = Array.from({ length: 30 }, (_, index) => ({
			...postgresKind,
			kind: `warehouse_${index}`,
			title: `Warehouse ${index}`,
		}));
		setup({}, { kinds, entries: [] });

		await user.click(await screen.findByRole('button', { name: /Add integration/i }));
		expect(await screen.findAllByTestId('kind-card')).toHaveLength(30);
		await user.type(screen.getByRole('searchbox', { name: 'Search integration catalog' }), '29');

		expect(screen.getAllByTestId('kind-card')).toHaveLength(1);
		expect(screen.getByText('Warehouse 29')).toBeInTheDocument();
	});

	it('filters the catalog by category and clears empty results', async () => {
		const user = userEvent.setup();
		setup({}, { kinds: [postgresKind, customEnvKind], entries: [] });

		await user.click(await screen.findByRole('button', { name: /Add integration/i }));
		await user.click(await screen.findByRole('button', { name: 'Other 1' }));
		expect(screen.getAllByTestId('kind-card')).toHaveLength(1);
		expect(screen.getByText('Custom env vars')).toBeInTheDocument();
		expect(screen.queryByText('Postgres')).not.toBeInTheDocument();

		await user.type(
			screen.getByRole('searchbox', { name: 'Search integration catalog' }),
			'missing',
		);
		expect(await screen.findByText('No matching integration types')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Clear Filters' }));
		expect(screen.getAllByTestId('kind-card')).toHaveLength(2);
	});
});

describe('ProjectIntegrationsPanel — list view', () => {
	it('renders rows with name, kind title, and a disabled badge', async () => {
		setup(
			{},
			{
				kinds: [postgresKind, customEnvKind],
				entries: [
					entry(),
					entry({ id: 'i_2', kind: 'custom_env', name: 'extra-env', enabled: false }),
				],
			},
		);
		const rows = await screen.findAllByTestId('integration-row');
		expect(rows).toHaveLength(2);

		expect(screen.getByText('prod-db')).toBeInTheDocument();
		expect(screen.getByText(/Postgres/)).toBeInTheDocument();
		expect(screen.getByText('extra-env')).toBeInTheDocument();
		expect(screen.getByText(/Custom env vars/)).toBeInTheDocument();
		expect(screen.getByText('disabled')).toBeInTheDocument();
	});

	it('hides Add/Edit/Delete controls for a non-admin viewer', async () => {
		setup(
			{ project: project({ your_role: 'viewer' }) },
			{ kinds: [postgresKind], entries: [entry()] },
		);
		await screen.findByTestId('integration-row');
		expect(screen.queryByRole('button', { name: /add integration/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /edit prod-db/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /delete prod-db/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /disable/i })).not.toBeInTheDocument();
	});

	it('searches configured integrations by name and kind metadata', async () => {
		const user = userEvent.setup();
		const entries = Array.from({ length: 30 }, (_, index) =>
			entry({
				id: `i_${index}`,
				kind: index % 2 === 0 ? 'postgres' : 'custom_env',
				name: `connection-${index}`,
			}),
		);
		setup({}, { kinds: [postgresKind, customEnvKind], entries });

		expect(await screen.findAllByTestId('integration-row')).toHaveLength(30);
		// Paste rather than `type`: filtering is synchronous, so per-keystroke typing
		// just re-renders all 30 rows 13 times and can blow the test timeout in CI.
		await user.click(screen.getByRole('searchbox', { name: 'Search configured integrations' }));
		await user.paste('connection-29');

		expect(screen.getAllByTestId('integration-row')).toHaveLength(1);
		expect(screen.getByText('connection-29')).toBeInTheDocument();
		expect(screen.getByText('1 of 30 integrations')).toBeInTheDocument();
	});
});

describe('ProjectIntegrationsPanel — create flow', () => {
	it('picks a kind from the catalog, fills the form, and POSTs the pruned config', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, { kinds: [postgresKind, customEnvKind], entries: [] });

		await user.click(await screen.findByRole('button', { name: /add integration/i }));
		const cards = await screen.findAllByTestId('kind-card');
		expect(cards).toHaveLength(2);
		await user.click(screen.getByText('Postgres'));

		await user.type(screen.getByLabelText('Name'), 'prod');
		await user.type(screen.getByLabelText('Host'), 'db.internal');
		await user.click(screen.getByRole('button', { name: /add integration/i }));

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post).toBeTruthy();
			expect(post!.url).toContain(`/projects/${PID}/integrations`);
			expect(post!.body).toEqual({
				kind: 'postgres',
				name: 'prod',
				config: { host: 'db.internal' },
			});
		});

		expect(await screen.findByText('No integrations yet.')).toBeInTheDocument();
	});

	it('shows a validation error and does not POST when the name is empty', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, { kinds: [postgresKind], entries: [] });

		await user.click(await screen.findByRole('button', { name: /add integration/i }));
		await user.click(screen.getByText('Postgres'));
		await user.type(screen.getByLabelText('Host'), 'db.internal');
		await user.click(screen.getByRole('button', { name: /add integration/i }));

		expect(await screen.findByText(/lowercase letters, digits, and hyphens/i)).toBeInTheDocument();
		expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
	});

	it('creates a passwordless ClickHouse integration without a configured secret source', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, { kinds: [clickhouseKind], entries: [] });

		await user.click(await screen.findByRole('button', { name: /add integration/i }));
		await user.click(screen.getByText('ClickHouse'));
		expect(screen.queryByText(/no integration secret source/i)).not.toBeInTheDocument();
		await user.type(screen.getByLabelText('Name'), 'analytics');
		await user.type(screen.getByLabelText('Host'), 'clickhouse.internal');
		await user.click(screen.getByRole('button', { name: /add integration/i }));

		await waitFor(() => {
			const post = calls.find((call) => call.method === 'POST');
			expect(post?.body).toEqual({
				kind: 'clickhouse',
				name: 'analytics',
				config: {
					host: 'clickhouse.internal',
					port: 8443,
					secure: true,
					verify: true,
					database: 'default',
					username: 'default',
				},
			});
		});
	});
});

describe('ProjectIntegrationsPanel — edit flow', () => {
	const detail: IntegrationDetail = {
		...entry(),
		config: {
			host: 'db.internal',
			password: { $secret: { kind: 'managed', set: true } },
		},
	};

	it('preserves an untouched secret when editing a non-secret field', async () => {
		const user = userEvent.setup();
		const { calls } = setup(
			{},
			{ kinds: [secretKind], entries: [entry()], details: { i_1: detail } },
		);
		await user.click(await screen.findByRole('button', { name: 'Edit prod-db' }));
		const host = await screen.findByLabelText('Host');
		expect(screen.getByText(/\(set\)/)).toBeInTheDocument();
		await user.clear(host);
		await user.type(host, 'db2.internal');
		await user.click(screen.getByRole('button', { name: 'Save changes' }));

		await waitFor(() => {
			const patch = calls.find((call) => call.method === 'PATCH');
			expect(patch?.body).toEqual({
				name: 'prod-db',
				config: {
					host: 'db2.internal',
					password: { $secret: { kind: 'managed', set: true } },
				},
			});
		});
	});

	it('does not PATCH after Replace is selected but the required secret is left blank', async () => {
		const user = userEvent.setup();
		const { calls } = setup(
			{},
			{ kinds: [secretKind], entries: [entry()], details: { i_1: detail } },
		);
		await user.click(await screen.findByRole('button', { name: 'Edit prod-db' }));
		await user.click(await screen.findByRole('button', { name: 'Replace' }));
		await user.click(screen.getByRole('button', { name: 'Save changes' }));

		expect(await screen.findByText('Required')).toBeInTheDocument();
		expect(calls.find((call) => call.method === 'PATCH')).toBeUndefined();
	});

	it('carries the detail ETag into PATCH as If-Match', async () => {
		const user = userEvent.setup();
		const { calls } = setup(
			{},
			{ kinds: [secretKind], entries: [entry()], details: { i_1: detail } },
		);
		await user.click(await screen.findByRole('button', { name: 'Edit prod-db' }));
		await user.click(await screen.findByRole('button', { name: 'Save changes' }));

		await waitFor(() => {
			const patch = calls.find((call) => call.method === 'PATCH');
			expect(patch?.headers['if-match']).toBe('"detail-version"');
		});
	});

	it('tests unsaved edits while identifying the stored integration for keep-markers', async () => {
		const user = userEvent.setup();
		const { calls } = setup(
			{},
			{
				kinds: [{ ...secretKind, supports_test: true }],
				entries: [entry()],
				details: { i_1: detail },
			},
		);
		await user.click(await screen.findByRole('button', { name: 'Edit prod-db' }));
		const host = await screen.findByLabelText('Host');
		await user.clear(host);
		await user.type(host, 'edited.internal');
		await user.click(screen.getByRole('button', { name: 'Test connection' }));

		await waitFor(() => {
			const test = calls.find((call) => call.url.includes('/integrations/test'));
			expect(test?.body).toEqual({
				source: 'draft',
				id: 'i_1',
				kind: 'postgres',
				config: {
					host: 'edited.internal',
					password: { $secret: { kind: 'managed', set: true } },
				},
			});
		});
	});

	it('keeps the editor and its values open when PATCH fails', async () => {
		const user = userEvent.setup();
		setup(
			{},
			{
				kinds: [secretKind],
				entries: [entry()],
				details: { i_1: detail },
				patchError: true,
			},
		);
		await user.click(await screen.findByRole('button', { name: 'Edit prod-db' }));
		const host = await screen.findByLabelText('Host');
		await user.clear(host);
		await user.type(host, 'retry.internal');
		await user.click(screen.getByRole('button', { name: 'Save changes' }));

		expect(await screen.findByText(/boom/)).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Edit prod-db' })).toBeInTheDocument();
		expect(screen.getByLabelText('Host')).toHaveValue('retry.internal');
	});
});

describe('ProjectIntegrationsPanel — delete flow', () => {
	it('confirms via ConfirmDialog before deleting', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, { kinds: [postgresKind], entries: [entry()] });

		await user.click(await screen.findByRole('button', { name: 'Delete prod-db' }));
		expect(await screen.findByRole('heading', { name: 'Delete integration' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await waitFor(() => {
			const del = calls.find((c) => c.method === 'DELETE');
			expect(del).toBeTruthy();
			expect(del!.url).toContain(`/projects/${PID}/integrations/i_1`);
		});
	});
});

describe('ProjectIntegrationsPanel — enable/disable', () => {
	it('PATCHes {enabled: false} when disabling an enabled integration', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, { kinds: [postgresKind], entries: [entry({ enabled: true })] });

		await user.click(await screen.findByRole('button', { name: 'Disable' }));

		await waitFor(() => {
			const patch = calls.find((c) => c.method === 'PATCH');
			expect(patch).toBeTruthy();
			expect(patch!.url).toContain(`/projects/${PID}/integrations/i_1`);
			expect(patch!.body).toEqual({ enabled: false });
		});
	});
});

describe('ProjectIntegrationsPanel — inherited org integrations', () => {
	it('marks inherited entries and hides their controls, even for a project admin', async () => {
		setup(
			{},
			{
				kinds: [postgresKind],
				entries: [
					entry(),
					entry({ id: 'org_1', name: 'warehouse', scope: 'org' }),
					entry({ id: 'org_2', name: 'prod-db', scope: 'org', shadowed: true }),
				],
			},
		);
		const rows = await screen.findAllByTestId('integration-row');
		expect(rows).toHaveLength(3);
		expect(screen.getAllByText('org')).toHaveLength(2);
		expect(screen.getByText('overridden')).toBeInTheDocument();

		// The project-owned row keeps its controls; inherited rows have none.
		expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Edit warehouse' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Delete warehouse' })).not.toBeInTheDocument();
	});
});

describe('OrgIntegrationsDialog', () => {
	function setupOrg(fetchOpts: FetchOpts) {
		const calls = makeFetch(fetchOpts);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
				<Toaster />
			</QueryClientProvider>
		);
		render(<OrgIntegrationsDialog isOpen onClose={vi.fn()} />, { wrapper });
		return { calls };
	}

	it('lists org instances with management controls', async () => {
		setupOrg({
			kinds: [postgresKind],
			entries: [],
			orgEntries: [entry({ id: 'org_1', name: 'warehouse', scope: 'org' })],
		});
		expect(await screen.findByRole('heading', { name: 'Org integrations' })).toBeInTheDocument();
		expect(await screen.findByText('warehouse')).toBeInTheDocument();
		// Org-owned rows are managed here, so they keep their controls.
		expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Edit warehouse' })).toBeInTheDocument();
	});

	it('creates through /org/integrations', async () => {
		const user = userEvent.setup();
		const { calls } = setupOrg({ kinds: [postgresKind], entries: [], orgEntries: [] });

		await user.click(await screen.findByRole('button', { name: /Add integration/ }));
		await user.click(await screen.findByTestId('kind-card'));
		await user.type(screen.getByLabelText('Name'), 'warehouse');
		await user.type(screen.getByLabelText(/host/i), 'db.internal');
		await user.click(screen.getByRole('button', { name: 'Add integration' }));

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post).toBeTruthy();
			expect(post!.url).toContain('/api/v1/org/integrations');
			expect(post!.url).not.toContain('/projects/');
			expect(post!.body).toMatchObject({ kind: 'postgres', name: 'warehouse' });
		});
	});
});

describe('ProjectIntegrationsPanel — copy from another project', () => {
	const SOURCE = {
		id: 'p_2',
		name: 'Analytics',
		your_role: 'admin',
		entries: [entry({ id: 'i_src', name: 'prod-db' })],
	};

	async function openCopy(user: ReturnType<typeof userEvent.setup>) {
		await user.click(await screen.findByRole('button', { name: /Add integration/ }));
		await user.click(await screen.findByRole('button', { name: /Copy from another project/ }));
		await user.type(screen.getByRole('combobox', { name: 'Source project' }), 'Analytics');
		await user.click(await screen.findByRole('option', { name: 'Analytics' }));
	}

	it('POSTs to …/integrations/copy with the picked source and name', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, { kinds: [postgresKind], entries: [], sourceProject: SOURCE });
		await openCopy(user);

		await user.click(await screen.findByTestId('copy-source-row'));
		const nameField = screen.getByLabelText('Name in this project');
		await user.clear(nameField);
		await user.type(nameField, 'analytics-db');
		await user.click(screen.getByRole('button', { name: 'Copy integration' }));

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST' && c.url.includes('/copy'));
			expect(post).toBeTruthy();
			expect(post!.url).toContain(`/projects/${PID}/integrations/copy`);
			expect(post!.body).toEqual({
				source_project_id: 'p_2',
				source_integration_id: 'i_src',
				name: 'analytics-db',
			});
		});
	});

	it('offers projects from every /projects page, not just the first', async () => {
		const user = userEvent.setup();
		setup({}, { kinds: [postgresKind], entries: [], sourceProject: SOURCE, pagedProjects: true });
		await openCopy(user);
		expect(await screen.findByTestId('copy-source-row')).toBeInTheDocument();
	});

	it('a cursor that never advances fails the picker loudly, not with a partial roster', async () => {
		const user = userEvent.setup();
		setup({}, { kinds: [postgresKind], entries: [], sourceProject: SOURCE, loopingProjects: true });
		await user.click(await screen.findByRole('button', { name: /Add integration/ }));
		await user.click(await screen.findByRole('button', { name: /Copy from another project/ }));
		expect(await screen.findByText(/Could not load the project list/)).toBeInTheDocument();
		expect(screen.queryByRole('combobox', { name: 'Source project' })).not.toBeInTheDocument();
	});

	it('never shows the pick/submit form before the source role resolves', async () => {
		const user = userEvent.setup();
		setup(
			{},
			{
				kinds: [postgresKind],
				entries: [],
				sourceProject: { ...SOURCE, your_role: 'viewer' },
				slowRole: true,
			},
		);
		await openCopy(user);
		// While the role check is in flight, nothing selectable renders…
		expect(screen.queryByTestId('copy-source-row')).not.toBeInTheDocument();
		// …and a viewer lands on the explanation, never a submittable form.
		expect(await screen.findByText(/on both projects/)).toBeInTheDocument();
		expect(screen.queryByTestId('copy-source-row')).not.toBeInTheDocument();
	});

	it('explains that admin is required on the source project', async () => {
		const user = userEvent.setup();
		setup(
			{},
			{
				kinds: [postgresKind],
				entries: [],
				sourceProject: { ...SOURCE, your_role: 'viewer' },
			},
		);
		await openCopy(user);
		expect(await screen.findByText(/on both projects/)).toBeInTheDocument();
		expect(screen.queryByTestId('copy-source-row')).not.toBeInTheDocument();
	});

	it('does not offer the copy entry point in the org dialog', async () => {
		const user = userEvent.setup();
		makeFetch({ kinds: [postgresKind], entries: [], orgEntries: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(<OrgIntegrationsDialog isOpen onClose={vi.fn()} />, {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		});
		await user.click(await screen.findByRole('button', { name: /Add integration/ }));
		expect(await screen.findAllByTestId('kind-card')).not.toHaveLength(0);
		expect(
			screen.queryByRole('button', { name: /Copy from another project/ }),
		).not.toBeInTheDocument();
	});
});
