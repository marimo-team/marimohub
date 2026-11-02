import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMatchMedia, jsonOk, renderWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { McpDialog } from './McpDialog';

const url = 'https://hub.example.com/hub/mcp';
const token = 'mhub_pat_test_secret';
function setup(
	manualTokens?: boolean,
	fail = false,
	options: {
		createResponse?: () => Promise<Response>;
		capabilitiesResponse?: () => Promise<Response>;
	} = {},
) {
	installMatchMedia(false);
	const calls: unknown[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === '/api/v1/capabilities') {
				if (options.capabilitiesResponse) return options.capabilitiesResponse();
				return jsonOk({ mcp: { available: true, url, manual_tokens: manualTokens } });
			}
			if (String(input) === '/api/v1/me/tokens/mcp' && init?.method === 'POST') {
				calls.push(JSON.parse(String(init.body)));
				if (options.createResponse) return options.createResponse();
				if (fail)
					return Response.json(
						{
							success: false,
							error: { code: 'NOT_FOUND', message: 'Manual MCP tokens are not enabled' },
						},
						{ status: 404 },
					);
				return jsonOk({
					id: 'id',
					name: 'my-client',
					token,
					mcp_resource: url,
					created_at: new Date().toISOString(),
				});
			}
			throw new Error(`Unexpected request: ${String(input)}`);
		}),
	);
	const onClose = vi.fn();
	const rendered = renderWithClient(<McpDialog isOpen onClose={onClose} />, { route: '/' });
	return { calls, onClose, ...rendered };
}
async function fillTokenForm(user: ReturnType<typeof userEvent.setup>, name = 'my-client') {
	await user.click(await screen.findByRole('tab', { name: 'Token' }));
	await user.type(screen.getByLabelText('Name'), name);
	await user.click(screen.getByRole('radio', { name: /^Read/ }));
	await user.click(screen.getByRole('radio', { name: /^All projects/ }));
}

afterEach(() => vi.unstubAllGlobals());

describe('McpDialog manual tokens', () => {
	it.each([undefined, false])(
		'hides manual token creation when availability is %s',
		async (enabled) => {
			setup(enabled);
			await screen.findByLabelText('MCP server URL');
			expect(screen.queryByRole('tab', { name: 'Token' })).not.toBeInTheDocument();
			expect(screen.getByRole('tab', { name: 'Cursor' })).toBeVisible();
		},
	);

	it('creates a scoped token and clears the secret when closed', async () => {
		const user = userEvent.setup();
		const { calls, rerender, onClose } = setup(true);
		await user.click(await screen.findByRole('tab', { name: 'Token' }));
		const create = screen.getByRole('button', { name: 'Create MCP token' });
		expect(create).toBeDisabled();
		await user.type(screen.getByLabelText('Name'), 'my-client');
		expect(screen.getByLabelText('Expires in days')).toHaveValue('30');
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		expect(create).toBeDisabled();
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.click(create);
		expect(await screen.findByLabelText('Header value')).toHaveValue(`Bearer ${token}`);
		expect(screen.getByLabelText('Header name')).toHaveValue('Authorization');
		expect(screen.getByText(/shown once and cannot be retrieved later/)).toBeVisible();
		expect(calls).toEqual([
			{
				name: 'my-client',
				expires_in_days: 30,
				grant: { actions: ['app.read', 'project.read', 'integration.read'], projects: '*' },
			},
		]);
		rerender(<McpDialog isOpen={false} onClose={onClose} />);
		rerender(<McpDialog isOpen onClose={onClose} />);
		await user.click(await screen.findByRole('tab', { name: 'Token' }));
		expect(screen.queryByLabelText('Header value')).not.toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveValue('');
	});

	it('preserves the secret across tab changes until the dialog closes', async () => {
		const user = userEvent.setup();
		const { calls, rerender, onClose } = setup(true);
		await fillTokenForm(user);
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(await screen.findByLabelText('Header value')).toHaveValue(`Bearer ${token}`);

		await user.click(screen.getByRole('tab', { name: 'Other' }));
		expect(screen.queryByRole('textbox', { name: 'Header value' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('tab', { name: 'Token' }));
		expect(screen.getByRole('textbox', { name: 'Header value' })).toHaveValue(`Bearer ${token}`);
		expect(calls).toHaveLength(1);

		await user.click(screen.getByRole('tab', { name: 'Other' }));
		rerender(<McpDialog isOpen={false} onClose={onClose} />);
		rerender(<McpDialog isOpen onClose={onClose} />);
		await user.click(await screen.findByRole('tab', { name: 'Token' }));
		expect(screen.queryByLabelText('Header value')).not.toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveValue('');
	});

	it('preserves the draft and a creation that completes on another tab', async () => {
		const user = userEvent.setup();
		const pending = deferred<Response>();
		const { calls } = setup(true, false, { createResponse: () => pending.promise });
		await fillTokenForm(user);
		await user.click(screen.getByRole('tab', { name: 'Other' }));
		expect(screen.queryByRole('button', { name: 'Create MCP token' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('tab', { name: 'Token' }));
		expect(screen.getByLabelText('Name')).toHaveValue('my-client');
		expect(screen.getByRole('radio', { name: /^Read/ })).toBeChecked();
		expect(screen.getByRole('radio', { name: /^All projects/ })).toBeChecked();

		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		await user.click(screen.getByRole('tab', { name: 'Other' }));
		await act(async () => pending.resolve(jsonOk({ token })));
		expect(screen.queryByRole('textbox', { name: 'Header value' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('tab', { name: 'Token' }));
		expect(screen.getByRole('textbox', { name: 'Header value' })).toHaveValue(`Bearer ${token}`);
		expect(calls).toHaveLength(1);
	});

	it('validates expiry and surfaces a disabled-feature error without displaying a secret', async () => {
		const user = userEvent.setup();
		const { calls } = setup(true, true);
		await fillTokenForm(user);
		await user.clear(screen.getByLabelText('Expires in days'));
		await user.type(screen.getByLabelText('Expires in days'), '0');
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(
			await screen.findByText('Expiry must be a whole number from 1 to 3650 days.'),
		).toBeVisible();
		expect(calls).toHaveLength(0);
		await user.clear(screen.getByLabelText('Expires in days'));
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(await screen.findByText('Manual MCP tokens are not enabled')).toBeVisible();
		expect(screen.queryByLabelText('Header value')).not.toBeInTheDocument();
	});
	it('keeps token creation hidden when capabilities cannot load', async () => {
		setup(true, false, {
			capabilitiesResponse: async () =>
				Response.json(
					{ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' } },
					{ status: 503 },
				),
		});
		expect(
			await screen.findByText('Could not load MCP settings. Close this dialog and try again.'),
		).toBeVisible();
		expect(screen.queryByRole('tab', { name: 'Token' })).not.toBeInTheDocument();
	});

	it.each(['-1', '1.5', '3651', 'soon'])('does not submit an invalid expiry: %s', async (days) => {
		const user = userEvent.setup();
		const { calls } = setup(true);
		await fillTokenForm(user);
		await user.clear(screen.getByLabelText('Expires in days'));
		await user.type(screen.getByLabelText('Expires in days'), days);
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(
			await screen.findByText('Expiry must be a whole number from 1 to 3650 days.'),
		).toBeVisible();
		expect(calls).toHaveLength(0);
	});

	it('requires a nonblank name before submission', async () => {
		const user = userEvent.setup();
		const { calls } = setup(true);
		await user.click(await screen.findByRole('tab', { name: 'Token' }));
		await user.click(screen.getByRole('radio', { name: /^Read/ }));
		await user.click(screen.getByRole('radio', { name: /^All projects/ }));
		await user.type(screen.getByLabelText('Name'), '   ');
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(await screen.findByText('Name the token so you can recognize it later.')).toBeVisible();
		expect(calls).toHaveLength(0);
	});

	it('preserves the form after a network failure and permits a deliberate retry', async () => {
		const user = userEvent.setup();
		const createResponse = vi
			.fn<() => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError('Network unavailable'))
			.mockResolvedValueOnce(jsonOk({ token }));
		const { calls } = setup(true, false, { createResponse });
		await fillTokenForm(user, ' my-client ');
		await user.clear(screen.getByLabelText('Expires in days'));
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(await screen.findByText('Network unavailable')).toBeVisible();
		expect(screen.queryByLabelText('Header value')).not.toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveValue(' my-client ');
		expect(screen.getByRole('radio', { name: /^Read/ })).toBeChecked();
		expect(calls).toHaveLength(1);
		await user.click(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(await screen.findByLabelText('Header value')).toHaveValue(`Bearer ${token}`);
		expect(calls).toEqual([
			{
				name: 'my-client',
				grant: { actions: ['app.read', 'project.read', 'integration.read'], projects: '*' },
			},
			{
				name: 'my-client',
				grant: { actions: ['app.read', 'project.read', 'integration.read'], projects: '*' },
			},
		]);
	});

	it('disables submission while pending and does not reveal a late token after reopening', async () => {
		const user = userEvent.setup();
		const pending = deferred<Response>();
		const { calls, rerender, onClose } = setup(true, false, {
			createResponse: () => pending.promise,
		});
		await fillTokenForm(user);
		await user.dblClick(screen.getByRole('button', { name: 'Create MCP token' }));
		expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
		expect(calls).toHaveLength(1);
		rerender(<McpDialog isOpen={false} onClose={onClose} />);
		await act(async () => pending.resolve(jsonOk({ token })));
		rerender(<McpDialog isOpen onClose={onClose} />);
		await user.click(await screen.findByRole('tab', { name: 'Token' }));
		expect(screen.queryByLabelText('Header value')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create MCP token' })).toBeDisabled();
		expect(screen.getByLabelText('Name')).toHaveValue('');
	});
});
