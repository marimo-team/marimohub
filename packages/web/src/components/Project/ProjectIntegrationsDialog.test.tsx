import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { OrgIntegrationsDialog, ProjectIntegrationsDialog } from './ProjectIntegrationsDialog';
import type { IntegrationDetail, IntegrationEntry, IntegrationKind, ProjectDetail } from '@/types';

const PID = 'p_1';

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
	({ id: PID, name: 'Demo', your_role: 'admin', ...over }) as ProjectDetail;

const postgresKind: IntegrationKind = {
	kind: 'postgres',
	title: 'Postgres',
	description: 'A postgres database',
	category: 'database',
	schema_version: 1,
	json_schema: {
		type: 'object',
		required: ['host'],
		properties: { host: { type: 'string' } },
	},
	ui_hints: {},
	supports_test: false,
	requirements: ['sqlalchemy>=2'],
};

const customEnvKind: IntegrationKind = {
	kind: 'custom_env',
	title: 'Custom env vars',
	description: 'Arbitrary env vars injected into every session',
	category: 'other',
	schema_version: 1,
	json_schema: { type: 'object', properties: {} },
	ui_hints: {},
	supports_test: true,
	requirements: [],
};

const secretKind: IntegrationKind = {
	...postgresKind,
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
}

/** Routes the dialog's list, detail, and probe requests through one mock. */
function makeFetch({
	kinds,
	entries,
	details = {},
	patchError = false,
	orgEntries = [],
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
			if (method === 'GET') return ok(orgEntries);
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
				return entries === null ? notFound() : ok(entries);
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
	overrides: Partial<React.ComponentProps<typeof ProjectIntegrationsDialog>> = {},
	fetchOpts: FetchOpts = { kinds: [postgresKind, customEnvKind], entries: [] },
) {
	const calls = makeFetch(fetchOpts);
	const onClose = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(
		<ProjectIntegrationsDialog isOpen onClose={onClose} project={project()} {...overrides} />,
		{ wrapper },
	);
	return { onClose, calls };
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

describe('ProjectIntegrationsDialog — disabled deployment', () => {
	it('shows a disabled message when the kinds/list routes 404', async () => {
		setup({}, { kinds: null, entries: null });
		expect(
			await screen.findByText('Integrations are not enabled on this deployment.'),
		).toBeInTheDocument();
	});
});

describe('ProjectIntegrationsDialog — query failures', () => {
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

describe('ProjectIntegrationsDialog — kind catalog', () => {
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

describe('ProjectIntegrationsDialog — list view', () => {
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
		await user.type(
			screen.getByRole('searchbox', { name: 'Search configured integrations' }),
			'connection-29',
		);

		expect(screen.getAllByTestId('integration-row')).toHaveLength(1);
		expect(screen.getByText('connection-29')).toBeInTheDocument();
		expect(screen.getByText('1 of 30 integrations')).toBeInTheDocument();
	});
});

describe('ProjectIntegrationsDialog — create flow', () => {
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
});

describe('ProjectIntegrationsDialog — edit flow', () => {
	const detail: IntegrationDetail = {
		...entry(),
		config: {
			host: 'db.internal',
			password: { $secret: { set: true } },
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
					password: { $secret: { set: true } },
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

describe('ProjectIntegrationsDialog — delete flow', () => {
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

describe('ProjectIntegrationsDialog — enable/disable', () => {
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

describe('ProjectIntegrationsDialog — inherited org integrations', () => {
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
