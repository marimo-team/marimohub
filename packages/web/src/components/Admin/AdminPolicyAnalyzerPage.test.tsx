import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonOk, renderWithClient } from '@/test/render';
import { AuthProvider } from '@/context/AuthContext';
import AdminPolicyAnalyzerPage from './AdminPolicyAnalyzerPage';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AdminPolicyAnalyzerPage', () => {
	it('builds a case and renders the deterministic trace', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
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
			}),
		);
		const user = userEvent.setup();
		renderWithClient(
			<AuthProvider>
				<AdminPolicyAnalyzerPage />
			</AuthProvider>,
		);

		expect(await screen.findByRole('heading', { name: 'Policy Analyzer' })).toBeInTheDocument();
		expect(screen.getByText('Login Policy: Not Configured')).toBeInTheDocument();
		expect(screen.queryByText('Explicit entitlements affect')).not.toBeInTheDocument();
		await user.click(screen.getByText('Entitlements & Standing'));
		expect(screen.getByText(/Explicit entitlements affect/)).toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: 'JSON suite' })).not.toBeVisible();
		await user.click(screen.getByText('JSON Test Suite'));
		const suiteEditor = screen.getByRole('textbox', { name: 'JSON suite' });
		expect(suiteEditor).toBeVisible();
		fireEvent.change(suiteEditor, {
			target: { value: JSON.stringify({ schema_version: 2, cases: [] }) },
		});
		expect(await screen.findAllByText('Use suite schema version 1.')).toHaveLength(2);
		expect(screen.getByRole('button', { name: /Run Suite/ })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: /Run Scenario/ }));
		expect(await screen.findByRole('heading', { name: 'Scenario Passed' })).toBeInTheDocument();
		expect(
			screen.getByText('The final authorization decision allows the action.'),
		).toBeInTheDocument();
	});
});
