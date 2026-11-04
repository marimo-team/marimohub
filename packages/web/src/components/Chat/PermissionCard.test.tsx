import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationPermission } from '@/api/conversations';
import { PermissionCard } from './PermissionCard';

const permission: ConversationPermission = {
	id: 'request',
	tool_call_id: 'call-1',
	kind: 'tool',
	action: 'Run code in a notebook session',
	details: [
		{ label: 'Notebook', value: 'Sales' },
		{ label: 'Code', value: 'import marimo as mo\nmo.md("hi")' },
	],
	scope: { key: 'tool:execute_code', label: 'running code in this project' },
	can_remember: false,
	status: 'open',
	expires_at: '2099-01-01T00:00:00Z',
};

describe('PermissionCard', () => {
	it('shows multi-line code in full, hides "always" for non-rememberable actions, and sends one decision', () => {
		const onDecide = vi.fn(() => new Promise<{ accepted: boolean }>(() => {}));
		render(<PermissionCard permission={permission} onDecide={onDecide} />);
		expect(screen.getByText(/mo\.md\("hi"\)/)).toBeInTheDocument();
		expect(screen.getAllByRole('button')).toHaveLength(2);
		expect(screen.queryByRole('button', { name: /Always allow/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
		fireEvent.click(screen.getByRole('button', { name: 'Do not allow' }));
		expect(onDecide).toHaveBeenCalledExactlyOnceWith('request', 'allow');
		for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
		expect(screen.getByRole('status')).toHaveTextContent('Sending…');
	});

	it('offers "always" only when the action can be remembered', () => {
		render(
			<PermissionCard
				permission={{ ...permission, can_remember: true }}
				onDecide={vi.fn(async () => ({ accepted: true }))}
			/>,
		);
		expect(
			screen.getByRole('button', { name: 'Always allow running code in this project' }),
		).toBeEnabled();
	});

	it.each([
		['allowed', 'Allowed once'],
		['remembered', 'Always allowed for running code in this project'],
		['denied', 'Not allowed'],
		['expired', 'No answer in time. Chat continued without it.'],
		['cancelled', 'Stopped'],
		['unavailable', 'This client cannot ask for permission.'],
	] as const)('renders the %s outcome on one line', (status, text) => {
		render(<PermissionCard permission={{ ...permission, status }} />);
		expect(screen.getByRole('status')).toHaveTextContent(text);
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
		// Settled cards show only the first line of long details.
		expect(screen.getByText(/Code: import marimo as mo$/)).toBeInTheDocument();
	});

	it('lets the user retry after a decision request fails', async () => {
		const onDecide = vi
			.fn<() => Promise<{ accepted: boolean }>>()
			.mockRejectedValueOnce(new Error('Offline'))
			.mockResolvedValueOnce({ accepted: true });
		render(<PermissionCard permission={permission} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('could not be sent');
		expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
		expect(onDecide).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('closes a stale request when the server rejects the decision', async () => {
		const onDecide = vi.fn(async () => ({ accepted: false }));
		render(<PermissionCard permission={permission} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
		expect(await screen.findByText('This permission request is closed.')).toBeInTheDocument();
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
	});

	it('disables decisions when the client has no decision handler', () => {
		render(<PermissionCard permission={permission} />);
		for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
	});
});
