import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { ChatUIMessage, ConversationPermission } from '@/api/conversations';
import { renderWithClient, setupUser } from '@/test/render';
import { ChatMessages } from './ChatMessages';

const onDecide = vi.fn(async () => ({ accepted: true }));
const tool = {
	type: 'dynamic-tool',
	toolName: 'list_notebooks',
	toolCallId: 'call-1',
	state: 'output-available',
	input: {},
	output: 'Found 3 notebooks',
} as const;
const reply: ChatUIMessage = {
	id: 'reply',
	role: 'assistant',
	parts: [
		{ type: 'text', text: 'I will look through the project.' },
		tool,
		{ type: 'text', text: 'Here are your notebooks.' },
	],
};

function renderMessages(messages = [reply]) {
	return renderWithClient(
		<ChatMessages messages={messages} onDecide={onDecide} onInspect={vi.fn()} />,
	);
}

describe('ChatMessages', () => {
	it('folds intermediate text and tools while keeping the final answer visible', async () => {
		const user = setupUser();
		renderMessages();
		expect(screen.getByText('Here are your notebooks.')).toBeVisible();
		expect(screen.getByText('I will look through the project.')).not.toBeVisible();
		const work = screen.getByRole('button', { name: 'Worked · 1 step' });
		expect(work).toHaveAttribute('aria-expanded', 'false');
		await user.click(work);
		expect(screen.getByRole('button', { name: /^Inspect list notebooks/ })).toBeVisible();
		expect(screen.getByText('I will look through the project.')).toBeVisible();
		await user.click(work);
		expect(screen.getByText('I will look through the project.')).not.toBeVisible();
	});

	it('keeps running work open, collapses on completion, and reopens for a later tool', async () => {
		const user = setupUser();
		const running: ChatUIMessage = {
			...reply,
			parts: [{ ...tool, state: 'input-available', output: undefined }],
		};
		const { rerender } = renderMessages([running]);
		const work = screen.getByRole('button', { name: 'Working · 1 step' });
		await user.click(work);
		expect(work).toHaveAttribute('aria-expanded', 'true');
		rerender(<ChatMessages messages={[reply]} onDecide={onDecide} />);
		expect(screen.getByRole('button', { name: 'Worked · 1 step' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		await user.click(screen.getByRole('button', { name: 'Worked · 1 step' }));
		rerender(<ChatMessages messages={[running]} onDecide={onDecide} />);
		expect(screen.getByRole('button', { name: 'Working · 1 step' })).toHaveAttribute(
			'aria-expanded',
			'true',
		);
		rerender(<ChatMessages messages={[reply]} onDecide={onDecide} />);
		expect(screen.getByRole('button', { name: 'Worked · 1 step' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
	});

	it('surfaces failures in the collapsed summary and lets users inspect the error', async () => {
		const user = setupUser();
		renderMessages([
			{
				...reply,
				parts: [
					{ ...tool, state: 'output-error', output: undefined, errorText: 'Permission denied' },
				],
			},
		]);
		const work = screen.getByRole('button', { name: /Worked · 1 step.*1 failed/ });
		expect(work).toHaveAttribute('aria-expanded', 'false');
		await user.click(work);
		expect(screen.getByText('Permission denied')).toBeVisible();
	});

	it('keeps orphaned approvals visible and actionable', async () => {
		const permission: ConversationPermission = {
			id: 'permission-1',
			tool_call_id: 'missing-call',
			action: 'Create notebook',
			status: 'open',
			details: [],
			can_remember: false,
			scope: { key: 'tool:create_notebook', label: 'this project' },
			kind: 'tool',
			expires_at: '2026-11-03T12:05:00Z',
		};
		const user = setupUser();
		renderMessages([{ ...reply, parts: [{ type: 'data-permission', data: permission }] }]);
		expect(screen.getByRole('button', { name: 'Waiting for permission · 1 step' })).toHaveAttribute(
			'aria-expanded',
			'true',
		);
		await user.click(screen.getByRole('button', { name: 'Allow once' }));
		expect(onDecide).toHaveBeenCalledWith('permission-1', 'allow');
	});

	it('copies message text and reuses a user message without changing history', async () => {
		const user = setupUser();
		const copy = vi.spyOn(navigator.clipboard, 'writeText');
		const onReuse = vi.fn();
		const message: ChatUIMessage = {
			id: 'user',
			role: 'user',
			parts: [{ type: 'text', text: 'Show my notebooks' }],
		};
		const { rerender } = renderWithClient(
			<ChatMessages messages={[message]} onDecide={onDecide} onReuse={onReuse} />,
		);
		const bubble = screen.getByRole('article', { name: 'Your message' });
		await user.click(within(bubble).getByRole('button', { name: 'Copy message' }));
		expect(copy).toHaveBeenCalledWith('Show my notebooks');
		expect(within(bubble).getByRole('button', { name: 'Copied message' })).toBeInTheDocument();
		await user.click(within(bubble).getByRole('button', { name: 'Use message as draft' }));
		expect(onReuse).toHaveBeenCalledWith('Show my notebooks');
		rerender(
			<ChatMessages messages={[message]} onDecide={onDecide} onReuse={onReuse} canReuse={false} />,
		);
		expect(screen.getByRole('button', { name: 'Use message as draft' })).toBeDisabled();
		expect(screen.getByText('Show my notebooks')).toBeVisible();
	});
});
