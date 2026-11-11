import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { jsonError, jsonOk } from '@/test/render';
import {
	deferred,
	installChatPageHooks,
	record,
	replyChunks,
	saved,
	setup,
	streamPath,
	textbox,
	textMessage,
	uiStream,
} from './ChatPage.testWorld';
import { conversationKeys } from '@/api/conversations';
import { notebookKeys } from '@/api/queryKeys';

installChatPageHooks();

describe('ChatPage', () => {
	it('keeps the empty state focused and fills the composer from a prompt chip', async () => {
		const { user, writes } = setup();
		await screen.findByRole('heading', { name: 'What should we build, Ada?' });
		expect(screen.queryByText('Recent conversations')).not.toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Sales report' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Explore this project' }));
		expect(textbox()).toHaveFocus();
		expect(textbox()).toHaveValue('Give me an overview of this project and what I can work on.');
		expect(writes).toEqual([]);
	});

	it('switches between conversations without closing history and preserves the draft when toggling it', async () => {
		const { user } = setup({
			conversations: [
				{ id: 'conversation-1', title: 'First chat' },
				{ id: 'conversation-2', title: 'Second chat' },
			],
			detailResponse: (cid) =>
				jsonOk({
					conversation: {
						...record,
						id: cid,
						messages: [textMessage(`reply-${cid}`, 'assistant', `Answer for ${cid}`)],
					},
				}),
		});
		await user.click(await screen.findByRole('button', { name: 'History' }));
		const history = screen.getByRole('complementary', { name: 'Your conversations' });
		await user.click(await within(history).findByRole('button', { name: /^First chat/ }));
		await screen.findByText('Answer for conversation-1');
		await user.click(within(history).getByRole('button', { name: /^Second chat/ }));
		await screen.findByText('Answer for conversation-2');
		expect(within(history).getByRole('button', { name: /^Second chat/ })).toHaveAttribute(
			'aria-current',
			'page',
		);
		await user.click(within(history).getByRole('button', { name: /^First chat/ }));
		await screen.findByText('Answer for conversation-1');
		await user.type(textbox(), 'Keep this draft');
		await user.click(within(history).getByRole('button', { name: /^First chat/ }));
		expect(textbox()).toHaveValue('Keep this draft');
		await user.click(screen.getByRole('button', { name: 'Collapse history' }));
		expect(
			screen.queryByRole('complementary', { name: 'Your conversations' }),
		).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		await user.click(screen.getByRole('button', { name: 'History' }));
		expect(textbox()).toHaveValue('Keep this draft');
		expect(screen.getByRole('complementary', { name: 'Your conversations' })).toBeVisible();
	});

	it('starts a conversation from the empty state, streams the reply, and refreshes project data', async () => {
		const { user, writes, client } = setup();
		client.setQueryData(notebookKeys.detail('sales', 'existing'), { title: 'Cached notebook' });
		client.setQueryData(notebookKeys.detail('finance', 'existing'), { title: 'Other notebook' });
		await screen.findByRole('heading', { name: 'What should we build, Ada?' });
		await user.type(textbox(), 'What notebooks are here?');
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		expect(await screen.findByText('Live project answer')).toBeInTheDocument();
		expect(writes.map((write) => write.path)).toEqual([
			'/api/v1/projects/sales/conversations',
			streamPath,
		]);
		expect(writes[1]?.body).toEqual({ content: 'What notebooks are here?' });
		expect(screen.getByTestId('location')).toHaveTextContent('conversation=conversation-1');
		await waitFor(() =>
			expect(client.getQueryState(notebookKeys.detail('sales', 'existing'))?.isInvalidated).toBe(
				true,
			),
		);
		expect(client.getQueryState(notebookKeys.detail('finance', 'existing'))?.isInvalidated).toBe(
			false,
		);
	});

	it('sends a follow-up question while an interrupted operation awaits review', async () => {
		let messages = record.messages;
		const { user, writes } = setup({
			route: saved,
			detailResponse: () =>
				jsonOk({
					conversation: {
						...record,
						messages,
						continuation: {
							status: 'needs_review',
							reason: 'interrupted',
							task: 'Create a notebook',
							observations: [],
							unresolved_calls: [{ id: 'call-1', name: 'execute_code' }],
						},
					},
				}),
			streamResponse: () =>
				uiStream(replyChunks, {
					onDone: () => {
						messages = [
							...record.messages,
							textMessage('user-2', 'user', 'Why did it fail?'),
							textMessage('reply-1', 'assistant', 'Live project answer'),
						];
					},
				}),
		});
		await screen.findByText('Review the interrupted task');
		await user.type(textbox(), 'Why did it fail?');
		expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() =>
			expect(writes).toContainEqual({
				method: 'POST',
				path: streamPath,
				body: { content: 'Why did it fail?' },
			}),
		);
		await screen.findByText('Live project answer');
	});

	it('dismisses a saved task without continuing it', async () => {
		const { user, writes } = setup({
			route: saved,
			detailResponse: () =>
				jsonOk({
					conversation: {
						...record,
						continuation: {
							status: 'paused',
							reason: 'stopped',
							task: 'Long task',
							observations: [],
							unresolved_calls: [],
						},
					},
				}),
		});
		await screen.findByText('Task paused');
		expect(screen.getByText(/You stopped the reply/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Dismiss task' }));
		await waitFor(() =>
			expect(writes.map((write) => write.path)).toEqual([
				'/api/v1/projects/sales/conversations/conversation-1/continuation/dismiss',
			]),
		);
	});

	it('provides a keyboard-focusable history region separate from the composer', async () => {
		setup({ route: saved });
		await screen.findByText('Persisted project findings');
		const history = screen.getByRole('region', { name: 'Chat history' });
		expect(within(history).getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
		expect(history).toHaveAttribute('tabindex', '0');
		expect(
			within(history).queryByRole('textbox', { name: 'Message the project assistant' }),
		).not.toBeInTheDocument();
		history.focus();
		expect(history).toHaveFocus();
	});

	it('follows new output near the bottom without interrupting a reader above it', async () => {
		const { client } = setup({ route: saved });
		await screen.findByText('Persisted project findings');
		const history = screen.getByRole('region', { name: 'Chat history' });
		Object.defineProperties(history, {
			scrollHeight: { value: 2000, configurable: true },
			clientHeight: { value: 400, configurable: true },
			scrollTop: { value: 300, writable: true, configurable: true },
		});
		const scroll = vi.spyOn(history, 'scrollTo');
		scroll.mockClear();
		fireEvent.scroll(history);
		const update = (content: string) =>
			act(() => {
				client.setQueryData(conversationKeys.detail('sales', record.id), {
					conversation: {
						...record,
						messages: [...record.messages, textMessage('reply', 'assistant', content)],
					},
				});
			});
		update('New output while reading');
		await screen.findByText('New output while reading');
		expect(scroll).not.toHaveBeenCalled();
		history.scrollTop = 1580;
		fireEvent.scroll(history);
		update('More output near the bottom');
		await screen.findByText('More output near the bottom');
		expect(scroll).toHaveBeenCalledWith({ top: 2000 });
	});

	it('opens saved conversations through accessible history and confirms deletion', async () => {
		const { user, writes } = setup();
		await user.click(await screen.findByRole('button', { name: 'History' }));
		const history = await screen.findByRole('complementary', { name: 'Your conversations' });
		await user.click(within(history).getByRole('button', { name: /^Saved investigation/ }));
		expect(await screen.findByText('Persisted project findings')).toBeInTheDocument();
		expect(within(history).getByRole('button', { name: /^Saved investigation/ })).toHaveAttribute(
			'aria-current',
			'page',
		);
		expect(screen.getByTestId('location')).toHaveTextContent('conversation=conversation-1');
		expect(history).toBeVisible();
		await user.click(
			within(screen.getByRole('complementary', { name: 'Your conversations' })).getByRole(
				'button',
				{
					name: 'Delete conversation Saved investigation',
				},
			),
		);
		expect(writes).toHaveLength(0);
		await user.click(
			within(screen.getByRole('dialog', { name: 'Delete conversation' })).getByRole('button', {
				name: 'Delete',
			}),
		);
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.method).toBe('DELETE');
		await waitFor(() =>
			expect(screen.getByTestId('location')).not.toHaveTextContent('conversation='),
		);
	});

	it.each(['loading', 'failed'])(
		'blocks Enter submission into a %s conversation',
		async (state) => {
			const pending = deferred<Response>();
			const { user, writes } = setup({
				route: saved,
				detailResponse:
					state === 'loading'
						? pending.promise
						: () => jsonError('NOT_FOUND', 'Conversation missing', 404),
			});
			await screen.findByRole('textbox', { name: 'Message the project assistant' });
			if (state === 'failed') await screen.findByText('Conversation missing');
			await user.type(textbox(), 'Do not send{Enter}');
			expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
			expect(writes).toHaveLength(0);
			if (state === 'loading')
				await act(async () => pending.resolve(jsonOk({ conversation: record })));
		},
	);

	it.each(['Enter', 'button'])(
		'clears on %s submission and preserves a new pending draft',
		async (method) => {
			const pending = deferred<Response>();
			const { user, writes } = setup({ route: saved, streamResponse: pending.promise });
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'First request');
			if (method === 'Enter') await user.keyboard('{Enter}');
			else await user.click(screen.getByRole('button', { name: 'Send message' }));
			expect(textbox()).toHaveValue('');
			await waitFor(() => expect(writes).toHaveLength(1));
			await user.type(textbox(), 'Next question');
			await act(async () => pending.resolve(uiStream(replyChunks)));
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled(),
			);
			expect(textbox()).toHaveValue('Next question');
		},
	);

	it.each(['', 'Next question'])(
		'preserves the draft after a failed send: %s',
		async (nextDraft) => {
			const pending = deferred<Response>();
			const { user, writes } = setup({ route: saved, streamResponse: pending.promise });
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'First request{Enter}');
			expect(textbox()).toHaveValue('');
			await waitFor(() => expect(writes).toHaveLength(1));
			if (nextDraft) await user.type(textbox(), nextDraft);
			await act(async () =>
				pending.resolve(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503)),
			);
			expect(await screen.findByRole('alert')).toHaveTextContent('Provider unavailable');
			expect(screen.getByRole('alert')).not.toHaveTextContent('SERVICE_UNAVAILABLE');
			expect(textbox()).toHaveValue(nextDraft || 'First request');
		},
	);

	it('recovers a failed history list without fetching an unselected detail', async () => {
		const { user } = setup({ listFails: true });
		await screen.findByText('History unavailable');
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		await screen.findByRole('heading', { name: 'What should we build, Ada?' });
		expect(screen.queryByText('Select a conversation first')).not.toBeInTheDocument();
		await user.type(textbox(), 'Ready');
		expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
	});

	it('does not send a message into another project when creation finishes late', async () => {
		const pending = deferred<Response>();
		const { user, writes } = setup({ createResponse: pending.promise });
		await user.type(
			await screen.findByRole('textbox', { name: 'Message the project assistant' }),
			'Sales question',
		);
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(writes).toHaveLength(1));
		await user.click(screen.getByRole('button', { name: 'Switch project' }));
		await screen.findByText('Finance');
		await act(async () => {
			pending.resolve(jsonOk({ conversation: record }));
			await pending.promise;
		});
		await waitFor(() =>
			expect(screen.getByTestId('location')).toHaveTextContent('/projects/finance/chat'),
		);
		expect(screen.getByTestId('location')).not.toHaveTextContent('conversation=');
		expect(writes.map((write) => write.path)).toEqual(['/api/v1/projects/sales/conversations']);
	});

	it('streams live tool activity in order and keeps the composer usable', async () => {
		const hold = deferred<void>();
		let finished = false;
		const final = {
			...record,
			messages: [
				...record.messages,
				textMessage('user-2', 'user', 'Summarize a table'),
				{
					id: 'reply-1',
					role: 'assistant',
					metadata: { created_at: '2026-10-14T01:01:00Z' },
					parts: [
						{ type: 'text', text: 'Let me look.' },
						{
							type: 'dynamic-tool',
							toolName: 'get_notebook',
							toolCallId: 'tool-1',
							state: 'output-available',
							input: '{"notebook":"Sales report"}',
							output: '{"title":"Sales report"}',
						},
						{ type: 'text', text: 'Sales totals are ready' },
					],
				},
			],
		};
		const { user } = setup({
			route: saved,
			streamResponse: () =>
				uiStream(
					[
						{ type: 'start', messageId: 'reply-1' },
						{ type: 'text-start', id: 't0' },
						{ type: 'text-delta', id: 't0', delta: 'Let me look.' },
						{ type: 'text-end', id: 't0' },
						{
							type: 'tool-input-start',
							toolCallId: 'tool-1',
							toolName: 'get_notebook',
							dynamic: true,
						},
						{
							type: 'tool-input-available',
							toolCallId: 'tool-1',
							toolName: 'get_notebook',
							input: '{"notebook":"Sales report"}',
							dynamic: true,
						},
					],
					{
						hold: hold.promise,
						rest: [
							{
								type: 'tool-output-available',
								toolCallId: 'tool-1',
								output: '{"title":"Sales report"}',
								dynamic: true,
							},
							{ type: 'text-start', id: 't1' },
							{ type: 'text-delta', id: 't1', delta: 'Sales totals are ready' },
							{ type: 'text-end', id: 't1' },
							{ type: 'finish' },
						],
						onDone: () => {
							finished = true;
						},
					},
				),
			detailResponse: () => jsonOk({ conversation: finished ? final : record }),
		});
		await screen.findByText('Persisted project findings');
		await user.type(textbox(), 'Summarize a table');
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		expect(await screen.findByText('Running get notebook…')).toBeInTheDocument();
		const activity = screen.getByRole('region', { name: 'marimohub tool activity' });
		expect(within(activity).getByText('Running')).toBeInTheDocument();
		expect(screen.getByText('Let me look.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
		await user.type(textbox(), 'Next');
		expect(screen.getByRole('button', { name: 'Queue message' })).toBeInTheDocument();
		await user.clear(textbox());
		expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
		await act(async () => hold.resolve());
		expect(await screen.findByText('Sales totals are ready')).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByText('Running get notebook…')).not.toBeInTheDocument(),
		);
		await user.click(screen.getByRole('button', { name: 'Worked · 1 step' }));
		expect(
			within(screen.getByRole('region', { name: 'marimohub tool activity' })).getByText(
				'Completed',
			),
		).toBeInTheDocument();
		// The intro text renders before the tool block, the conclusion after it.
		const log = screen.getByRole('log', { name: 'Conversation' });
		const order = [
			screen.getByText('Let me look.'),
			screen.getByRole('region', { name: 'marimohub tool activity' }),
			screen.getByText('Sales totals are ready'),
		].map((element) => [...log.querySelectorAll('*')].indexOf(element));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled());
		await user.type(textbox(), 'Next question');
		expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
	});

	it('shows a mid-stream error and restores the draft', async () => {
		const { user } = setup({
			route: saved,
			streamResponse: () =>
				uiStream([
					{ type: 'start', messageId: 'reply-1' },
					{ type: 'text-start', id: 't1' },
					{ type: 'text-delta', id: 't1', delta: 'Partial' },
					{ type: 'error', errorText: 'Model quota exceeded' },
				]),
		});
		await screen.findByText('Persisted project findings');
		await user.type(textbox(), 'Summarize a table{Enter}');
		expect(await screen.findByRole('alert')).toHaveTextContent('Model quota exceeded');
		expect(textbox()).toHaveValue('Summarize a table');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
	});

	it('shows the error envelope message when the stream request is rejected', async () => {
		const { user, writes } = setup({
			route: saved,
			streamResponse: () => jsonError('CONFLICT', 'A response is already in progress', 409),
		});
		await screen.findByText('Persisted project findings');
		await user.type(textbox(), 'Summarize a table{Enter}');
		expect(await screen.findByRole('alert')).toHaveTextContent('A response is already in progress');
		expect(screen.getByRole('alert')).not.toHaveTextContent('CONFLICT');
		expect(textbox()).toHaveValue('Summarize a table');
		expect(writes).toEqual([
			{ method: 'POST', path: streamPath, body: { content: 'Summarize a table' } },
		]);
	});
});
