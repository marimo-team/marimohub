import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ProjectSecretsDialog } from './ProjectSecretsDialog';
import { DOCS_FEDERATION_URL } from '@/lib/links';
import type { ProjectDetail, SecretEntry } from '@/types';

const PID = 'p_1';

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
	({ id: PID, name: 'Demo', your_role: 'admin', ...over }) as ProjectDetail;

function ok(data: unknown) {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

function notFound() {
	return new Response(
		JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'disabled' } }),
		{ status: 404, headers: { 'content-type': 'application/json' } },
	);
}

/** Route the dialog's requests: `/secrets` GET returns `secrets` (or 404 to disable). */
function makeFetch(secrets: SecretEntry[] | null) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		if (method !== 'GET') calls.push({ url, method, body });

		if (url.includes(`/projects/${PID}/secrets/validate`)) return ok({ ok: true });
		if (url.includes(`/projects/${PID}/secrets`)) {
			if (method === 'GET') return secrets === null ? notFound() : ok(secrets);
			if (method === 'PUT') return ok({ name: 'X', kind: 'reference' });
			if (method === 'DELETE') return ok(null);
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return calls;
}

function setup(
	overrides: Partial<React.ComponentProps<typeof ProjectSecretsDialog>> = {},
	secrets: SecretEntry[] | null = null,
) {
	const calls = makeFetch(secrets);
	const onSave = vi.fn();
	const onClose = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			{children}
			<Toaster />
		</QueryClientProvider>
	);
	render(
		<ProjectSecretsDialog
			isOpen
			onClose={onClose}
			project={project()}
			available
			onSave={onSave}
			{...overrides}
		/>,
		{ wrapper },
	);
	return { onSave, onClose, calls };
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

describe('ProjectSecretsDialog — federated access', () => {
	it('shows setup instructions + a docs link when federation is unavailable', () => {
		setup({ available: false });
		const link = screen.getByRole('link', { name: /how to enable it/i });
		expect(link).toHaveAttribute('href', DOCS_FEDERATION_URL);
		expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
	});

	it('shows the toggle when federation is available', () => {
		setup();
		expect(screen.getByRole('switch')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
	});

	it('disables Save until the toggle changes, then saves the new state', async () => {
		const user = userEvent.setup();
		const { onSave } = setup({ project: project({ federation: { enabled: false } }) });
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		await user.click(screen.getByRole('switch'));
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledWith(true);
	});
});

describe('ProjectSecretsDialog — stored keys', () => {
	it('hides the stored-keys section when the feature is disabled (list 404s)', async () => {
		setup({}, null);
		expect(await screen.findByText('Federated bucket access')).toBeInTheDocument();
		expect(screen.queryByText('Stored keys')).not.toBeInTheDocument();
	});

	it('lists reference entries with their locator', async () => {
		setup({}, [
			{
				name: 'OPENAI_API_KEY',
				kind: 'reference',
				ref: { backend: 'aws-sm', locator: 'prod/ai#OPENAI_API_KEY' },
				created_by: 'u',
				created_at: '',
				updated_at: '',
			},
		]);
		expect(await screen.findByText('OPENAI_API_KEY')).toBeInTheDocument();
		expect(screen.getByText(/prod\/ai#OPENAI_API_KEY/)).toBeInTheDocument();
	});

	it('adds a reference', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, []);
		await screen.findByText('Stored keys');
		await user.type(screen.getByLabelText('Env var name'), 'MY_KEY');
		await user.clear(screen.getByLabelText('Locator'));
		await user.type(screen.getByLabelText('Locator'), 'prod/x');
		await user.click(screen.getByRole('button', { name: /add secret/i }));

		await waitFor(() => {
			const put = calls.find((c) => c.method === 'PUT');
			expect(put).toBeTruthy();
			expect(put!.url).toContain('/secrets/MY_KEY');
			expect(put!.body).toMatchObject({ kind: 'reference', backend: 'aws-sm', locator: 'prod/x' });
		});
	});

	it('sends expand+prefix when the JSON toggle is on', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, []);
		await screen.findByText('Stored keys');
		await user.type(screen.getByLabelText('Env var name'), 'BUNDLE');
		await user.clear(screen.getByLabelText('Locator'));
		await user.type(screen.getByLabelText('Locator'), 'prod/all');
		await user.click(screen.getByRole('switch', { name: /expand json/i }));
		await user.type(screen.getByLabelText(/key prefix/i), 'APP_');
		await user.click(screen.getByRole('button', { name: /add secret/i }));

		await waitFor(() => {
			const put = calls.find((c) => c.method === 'PUT');
			expect(put!.body).toMatchObject({ kind: 'reference', expand: 'json', prefix: 'APP_' });
		});
	});

	it('renders a fan-out badge for a JSON reference', async () => {
		setup({}, [
			{
				name: 'BUNDLE',
				kind: 'reference',
				ref: { backend: 'aws-sm', locator: 'prod/all', expand: 'json', prefix: 'APP_' },
				created_by: 'u',
				created_at: '',
				updated_at: '',
			},
		]);
		expect(await screen.findByText(/expands JSON/i)).toBeInTheDocument();
	});

	it('the Test button dry-runs a validate call', async () => {
		const user = userEvent.setup();
		const { calls } = setup({}, []);
		await screen.findByText('Stored keys');
		await user.type(screen.getByLabelText('Env var name'), 'K');
		await user.clear(screen.getByLabelText('Locator'));
		await user.type(screen.getByLabelText('Locator'), 'prod/x');
		await user.click(screen.getByRole('button', { name: 'Test' }));

		await waitFor(() => {
			const post = calls.find((c) => c.url.includes('/secrets/validate'));
			expect(post).toBeTruthy();
			expect(post!.body).toMatchObject({ kind: 'reference', backend: 'aws-sm', locator: 'prod/x' });
		});
	});

	it('hides mutation controls for a non-admin viewer', async () => {
		setup({ project: project({ your_role: 'viewer' }) }, [
			{
				name: 'K',
				kind: 'reference',
				ref: { backend: 'aws-sm', locator: 'x' },
				created_by: 'u',
				created_at: '',
				updated_at: '',
			},
		]);
		await screen.findByText('Stored keys');
		expect(screen.queryByRole('button', { name: /add secret/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /delete k/i })).not.toBeInTheDocument();
	});
});
