import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { installMatchMedia, jsonOk, renderWithClient, setupUser } from '@/test/render';
import { CreateTokenForm } from './CreateTokenForm';

const PROJECT_ID = 'proj-0000000000000001';

function setup(kind: 'api' | 'mcp') {
	installMatchMedia();
	const requests: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith('/api/v1/projects')) {
				return jsonOk({ items: [{ id: PROJECT_ID, name: 'Analytics' }], next_cursor: null });
			}
			if (init?.method === 'POST' && url.startsWith('/api/v1/me/tokens/')) {
				requests.push({ url, body: JSON.parse(init.body as string) });
				return jsonOk({ id: '01HXY0S6GWMBASVAG3PZ7Y2K5T', name: 'client', token: 'secret' });
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	renderWithClient(<CreateTokenForm kind={kind} onCreated={vi.fn()} />);
	return { requests, user: setupUser() };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['api', 'mcp'] as const)('%s token project scope', (kind) => {
	it('removes deployment actions on scope changes and prevents selecting them again', async () => {
		const { user, requests } = setup(kind);
		await user.type(screen.getByLabelText('Name'), 'client');
		await user.click(screen.getByRole('button', { name: 'Advanced actions' }));
		await user.click(screen.getByRole('checkbox', { name: 'admin.access' }));
		await user.click(screen.getByRole('checkbox', { name: 'project.read' }));
		await user.click(screen.getByRole('radio', { name: /^Selected projects/ }));
		await user.click(await screen.findByRole('checkbox', { name: 'Analytics' }));

		const admin = screen.getByRole('checkbox', { name: 'admin.access' });
		expect(admin).not.toBeChecked();
		expect(admin).toBeDisabled();
		await user.click(admin);
		expect(admin).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'project.read' })).toBeChecked();

		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		expect(admin).toBeEnabled();
		expect(admin).not.toBeChecked();
		await user.click(admin);
		await user.click(screen.getByRole('radio', { name: /^Selected projects/ }));
		const create = screen.getByRole('button', { name: /create.*token/i });
		expect(create).toBeDisabled();
		expect(requests).toEqual([]);
		await user.click(await screen.findByRole('checkbox', { name: 'Analytics' }));
		await user.click(create);

		await waitFor(() =>
			expect(requests).toEqual([
				{
					url: `/api/v1/me/tokens/${kind === 'api' ? 'scoped' : 'mcp'}`,
					body: {
						name: 'client',
						...(kind === 'mcp' ? { expires_in_days: 30 } : {}),
						grant: { actions: ['project.read'], projects: [PROJECT_ID] },
					},
				},
			]),
		);
	});

	it('expands Full to project actions when editing a selected-project grant', async () => {
		const { user } = setup(kind);
		await user.click(screen.getByRole('radio', { name: 'Full' }));
		await user.click(screen.getByRole('radio', { name: /^Selected projects/ }));
		await user.click(await screen.findByRole('checkbox', { name: 'Analytics' }));
		expect(
			screen.getByText('Use all current and future actions within selected projects.'),
		).toBeVisible();
		expect(screen.getByRole('button', { name: /create.*token/i })).toBeEnabled();
		await user.click(screen.getByRole('button', { name: 'Advanced actions' }));
		for (const action of [
			'project.create',
			'admin.access',
			'org-integration.manage',
			'audit.global.read',
			'directory.search',
		]) {
			const checkbox = screen.getByRole('checkbox', { name: action });
			expect(checkbox).not.toBeChecked();
			expect(checkbox).toBeDisabled();
		}
		for (const action of ['project.read', 'notebook.write', 'session.start']) {
			const checkbox = screen.getByRole('checkbox', { name: action });
			expect(checkbox).toBeChecked();
			expect(checkbox).toBeEnabled();
		}
	});
});

describe('token expiry', () => {
	it.each([
		['api', '3650', 3650],
		['mcp', '90', 90],
	] as const)('accepts the %s maximum of %s days', async (kind, days, expected) => {
		const { user, requests } = setup(kind);
		await user.type(screen.getByLabelText('Name'), 'client');
		await user.click(screen.getByRole('radio', { name: 'Full' }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.clear(screen.getByLabelText('Expires in days'));
		await user.type(screen.getByLabelText('Expires in days'), days);
		await user.click(screen.getByRole('button', { name: /create.*token/i }));
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(requests[0].body).toMatchObject({ expires_in_days: expected });
	});

	it.each([
		['mcp', '', 90],
		['mcp', '91', 90],
		['api', '3651', 3650],
	] as const)('rejects a %s expiry of %j', async (kind, days, max) => {
		const { user, requests } = setup(kind);
		await user.type(screen.getByLabelText('Name'), 'client');
		await user.click(screen.getByRole('radio', { name: 'Full' }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.clear(screen.getByLabelText('Expires in days'));
		if (days) await user.type(screen.getByLabelText('Expires in days'), days);
		await user.click(screen.getByRole('button', { name: /create.*token/i }));
		expect(
			await screen.findByText(`Expiry must be a whole number from 1 to ${max} days.`),
		).toBeVisible();
		expect(requests).toEqual([]);
	});
});
