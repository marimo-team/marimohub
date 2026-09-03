import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonOk, renderWithClient } from '@/test/render';
import { AuthProvider } from '@/context/AuthContext';
import AdminPolicyAnalyzerPage from './AdminPolicyAnalyzerPage';

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) {
		const url = new URL(input.url);
		return `${url.pathname}${url.search}`;
	}
	return String(input);
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>, path: string): Request {
	const call = fetchMock.mock.calls.find(
		([input]) => requestUrl(input as RequestInfo | URL) === path,
	);
	if (!call) throw new Error(`expected a request to ${path}`);
	const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
	return input instanceof Request
		? input
		: new Request(new URL(String(input), 'http://test.local'), init);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AdminPolicyAnalyzerPage', () => {
	it('builds a case and renders the deterministic trace', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === '/api/v1/me') {
				return jsonOk({
					id: 'admin',
					email: 'admin@example.com',
					is_super_admin: true,
					can_create_projects: true,
					logout_url: null,
				});
			}
			if (url === '/api/v1/admin/users') {
				return jsonOk({
					items: [
						{
							id: 'admin',
							email: 'admin@example.com',
							name: 'Admin',
							updated_at: '2026-09-01T00:00:00.000Z',
							suspended_at: null,
							is_super_admin: true,
						},
					],
					next_cursor: null,
				});
			}
			if (url === '/api/v1/admin/policy-analyzer/metadata') {
				return jsonOk({
					schema_version: 1,
					max_cases: 25,
					capabilities: {
						login_policy: false,
						resource_security: true,
						live_self_context: false,
					},
					entitlements: ['super-admin', 'project-creator'],
					classification_order: ['LEVEL_1', 'LEVEL_2'],
					actions: [
						{
							action: 'project.read',
							scope: 'project',
							minimum_role: 'viewer',
							denied_as: 'not-found',
							requires_super_admin: false,
						},
					],
				});
			}
			if (url.startsWith('/api/v1/projects?')) {
				return jsonOk({ items: [], next_cursor: null });
			}
			if (url === '/api/v1/admin/policy-analyzer/evaluate') {
				return jsonOk({
					valid: true,
					summary: { case_count: 1, passed: 1, failed: 0 },
					cases: [
						{
							id: 'case-1',
							name: 'Policy check',
							valid: true,
							login: null,
							authorization: {
								decision: { allowed: true, role: 'admin' },
								presentation: 'allowed',
								trace: [
									{
										stage: 'constraint',
										status: 'skipped',
										code: 'resource_unlabeled',
									},
									{
										stage: 'final',
										status: 'passed',
										code: 'authorization_allowed',
									},
								],
								assertion: { passed: true, expected: { allowed: true } },
							},
							errors: [],
						},
					],
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const user = userEvent.setup();
		renderWithClient(
			<AuthProvider>
				<AdminPolicyAnalyzerPage />
			</AuthProvider>,
		);

		expect(await screen.findByRole('heading', { name: 'Policy Analyzer' })).toBeInTheDocument();
		expect(screen.getByText('Login Policy: Not Configured')).toBeInTheDocument();
		expect(screen.queryByText('Deterministic')).not.toBeInTheDocument();
		expect(screen.queryByText('Read-Only')).not.toBeInTheDocument();
		expect(screen.queryByText('Versioned')).not.toBeInTheDocument();
		expect(screen.queryByRole('textbox', { name: 'Subject ID' })).not.toBeInTheDocument();
		await user.selectOptions(screen.getByRole('combobox', { name: 'User' }), '');
		expect(screen.getByRole('textbox', { name: 'Subject ID' })).toHaveValue('test-user');
		expect(screen.getByRole('textbox', { name: 'Subject Email' })).toHaveValue('test@example.com');
		const entitlementsSummary = screen.getByText('Subject Options');
		const entitlementsSection = entitlementsSummary.closest('details');
		expect(entitlementsSection).not.toHaveAttribute('open');
		expect(screen.getByText('Select the entitlements that this identity has.')).not.toBeVisible();
		await user.click(entitlementsSummary);
		expect(entitlementsSection).toHaveAttribute('open');
		expect(screen.getByText('Select the entitlements that this identity has.')).toBeVisible();
		expect(screen.getByRole('textbox', { name: 'JSON suite' })).not.toBeVisible();
		await user.click(screen.getByText('JSON Suite'));
		const suiteEditor = screen.getByRole('textbox', { name: 'JSON suite' });
		expect(suiteEditor).toBeVisible();
		fireEvent.change(suiteEditor, {
			target: { value: JSON.stringify({ schema_version: 2, cases: [] }) },
		});
		expect(await screen.findAllByText('Use suite schema version 1.')).toHaveLength(2);
		expect(screen.getByRole('button', { name: /Run Suite/ })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: /Run Scenario/ }));
		expect(await screen.findByRole('heading', { name: 'Scenario Passed' })).toBeInTheDocument();
		const traceSummary = screen.getByText('Decision Details');
		expect(
			screen.getByText('The final authorization decision allows the action.'),
		).not.toBeVisible();
		await user.click(traceSummary);
		expect(screen.getByText('The final authorization decision allows the action.')).toBeVisible();
		const skippedStep = screen
			.getByText('No resource labels apply to this decision.')
			.closest('li');
		expect(skippedStep?.querySelector('svg')).toHaveClass('lucide-circle-dashed');
	});

	it('sends the API app mode for an app session scenario', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url === '/api/v1/me') {
				return jsonOk({
					id: 'admin',
					email: 'admin@example.com',
					is_super_admin: true,
					can_create_projects: true,
					logout_url: null,
				});
			}
			if (url === '/api/v1/admin/users') {
				return jsonOk({ items: [], next_cursor: null });
			}
			if (url === '/api/v1/admin/policy-analyzer/metadata') {
				return jsonOk({
					schema_version: 1,
					max_cases: 25,
					capabilities: {
						login_policy: true,
						resource_security: true,
						live_self_context: false,
					},
					entitlements: [],
					classification_order: [],
					actions: [
						{
							action: 'project.read',
							scope: 'project',
							minimum_role: 'viewer',
							denied_as: 'not-found',
							requires_super_admin: false,
						},
						{
							action: 'session.start',
							scope: 'session-start',
							minimum_role: 'viewer',
							denied_as: 'forbidden',
							requires_super_admin: false,
						},
					],
				});
			}
			if (url.startsWith('/api/v1/projects?')) {
				return jsonOk({ items: [], next_cursor: null });
			}
			if (url === '/api/v1/admin/policy-analyzer/evaluate') {
				return jsonOk({
					valid: true,
					summary: { case_count: 1, passed: 1, failed: 0 },
					cases: [],
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const user = userEvent.setup();
		renderWithClient(
			<AuthProvider>
				<AdminPolicyAnalyzerPage />
			</AuthProvider>,
		);

		await screen.findByRole('heading', { name: 'Policy Analyzer' });
		const loginPolicySummary = screen.getByText('Login Policy');
		expect(screen.getByRole('checkbox', { name: 'Evaluate the login policy' })).not.toBeVisible();
		await user.click(loginPolicySummary);
		expect(screen.getByRole('checkbox', { name: 'Evaluate the login policy' })).toBeVisible();
		await user.selectOptions(screen.getByRole('combobox', { name: 'Action' }), 'session.start');
		const mode = screen.getByRole('combobox', { name: 'Session Mode' });
		expect(mode).toHaveValue('edit');
		await user.selectOptions(mode, 'app');
		await user.click(screen.getByRole('button', { name: /Run Scenario/ }));

		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([input]) => requestUrl(input) === '/api/v1/admin/policy-analyzer/evaluate',
				),
			).toBe(true),
		);
		const request = requestOf(fetchMock, '/api/v1/admin/policy-analyzer/evaluate');
		const suite = JSON.parse(await request.text()) as {
			cases: { authorization: { resource: { mode?: string } } }[];
		};
		expect(suite.cases[0]?.authorization.resource.mode).toBe('app');
	});
});
