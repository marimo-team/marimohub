import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { jsonError, jsonOk } from '@/test/render';
import type { setupUser } from '@/test/render';
import {
	deferred,
	installChatPageHooks,
	record,
	saved,
	setup,
	stopPath,
	streamPath,
	textbox,
	textMessage,
	uiStream,
} from './ChatPage.testWorld';
import type { Write } from './ChatPage.testWorld';
import { conversationKeys } from '@/api/conversations';

installChatPageHooks();

describe('ChatPage', () => {
	describe('queueing and stopping a running response', () => {
		const secondChunks = [
			{ type: 'start', messageId: 'reply-2' },
			{ type: 'text-start', id: 't2' },
			{ type: 'text-delta', id: 't2', delta: 'Second answer' },
			{ type: 'text-end', id: 't2' },
			{ type: 'finish' },
		];
		const completed = {
			...record,
			messages: [
				...record.messages,
				textMessage('user-2', 'user', 'First question'),
				textMessage('reply-1', 'assistant', 'First answer'),
			],
		};
		function heldTurn() {
			const hold = deferred<void>();
			let finished = false;
			let streams = 0;
			const options = {
				route: saved,
				streamResponse: () => {
					streams += 1;
					if (streams > 1) return uiStream(secondChunks);
					return uiStream(
						[
							{ type: 'start', messageId: 'reply-1' },
							{ type: 'text-start', id: 't1' },
							{ type: 'text-delta', id: 't1', delta: 'First answer' },
						],
						{
							hold: hold.promise,
							rest: [{ type: 'text-end', id: 't1' }, { type: 'finish' }],
							onDone: () => {
								finished = true;
							},
						},
					);
				},
				detailResponse: () => jsonOk({ conversation: finished ? completed : record }),
			};
			return { hold, options };
		}
		async function startTurn(user: ReturnType<typeof setupUser>) {
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'First question{Enter}');
			await screen.findByRole('button', { name: 'Stop response' });
		}
		const streamWrites = (writes: Write[]) => writes.filter((write) => write.path === streamPath);

		it('queues a message typed during a response and sends it when the turn ends', async () => {
			const { hold, options } = heldTurn();
			const { user, writes } = setup(options);
			await startTurn(user);
			await user.type(textbox(), 'Second question{Enter}');
			const queued = screen.getByRole('region', { name: 'Queued messages' });
			expect(within(queued).getByText('Second question')).toBeInTheDocument();
			expect(streamWrites(writes)).toHaveLength(1);
			await act(async () => hold.resolve());
			await waitFor(() => expect(streamWrites(writes)).toHaveLength(2));
			expect(streamWrites(writes)[1]?.body).toEqual({ content: 'Second question' });
			await waitFor(() =>
				expect(screen.queryByRole('region', { name: 'Queued messages' })).not.toBeInTheDocument(),
			);
		});

		it('keeps streamed text and queued messages while the saved record still has a pending turn', async () => {
			const { hold, options } = heldTurn();
			let stale = false;
			const pending = { ...record, pending: { id: 'turn', expires_at: '2099-01-01T00:00:00Z' } };
			const { user, writes, client } = setup({
				...options,
				detailResponse: () => jsonOk({ conversation: stale ? pending : record }),
			});
			await startTurn(user);
			await user.type(textbox(), 'Second question{Enter}');
			stale = true;
			await act(async () => hold.resolve());
			const key = conversationKeys.detail('sales', 'conversation-1');
			await waitFor(() =>
				expect(client.getQueryData(key)).toMatchObject({
					conversation: { pending: pending.pending },
				}),
			);
			expect(screen.getByText('First answer')).toBeInTheDocument();
			expect(screen.getByRole('region', { name: 'Queued messages' })).toBeInTheDocument();
			expect(streamWrites(writes)).toHaveLength(1);
			await act(async () => client.setQueryData(key, { conversation: completed }));
			await waitFor(() => expect(streamWrites(writes)).toHaveLength(2));
		});

		it('discards queued messages when the user stops a turn', async () => {
			const { hold, options } = heldTurn();
			const { user, writes } = setup(options);
			await startTurn(user);
			await user.type(textbox(), 'Second question{Enter}');
			await user.click(screen.getByRole('button', { name: 'Stop response' }));
			await waitFor(() =>
				expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument(),
			);
			await act(async () => hold.resolve());
			expect(screen.queryByRole('region', { name: 'Queued messages' })).not.toBeInTheDocument();
			expect(streamWrites(writes)).toHaveLength(1);
		});

		it('stops a running response', async () => {
			const { hold, options } = heldTurn();
			const { user, writes } = setup(options);
			try {
				await startTurn(user);
				await user.click(screen.getByRole('button', { name: 'Stop response' }));
				await waitFor(() => expect(writes.map((write) => write.path)).toContain(stopPath));
				expect(writes.map((write) => [write.method, write.path])).toEqual([
					['POST', streamPath],
					['POST', stopPath],
				]);
				await user.type(textbox(), 'Next question');
				await waitFor(() =>
					expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled(),
				);
				expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument();
			} finally {
				await act(async () => hold.resolve());
			}
		});

		it('removes a queued message', async () => {
			const { hold, options } = heldTurn();
			const { user, writes } = setup(options);
			await startTurn(user);
			await user.type(textbox(), 'Second question{Enter}');
			await user.click(screen.getByRole('button', { name: 'Remove queued message 1' }));
			expect(screen.queryByRole('region', { name: 'Queued messages' })).not.toBeInTheDocument();
			await user.type(textbox(), 'Next question');
			await act(async () => hold.resolve());
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled(),
			);
			expect(streamWrites(writes)).toHaveLength(1);
		});
	});

	describe('leaving a streaming conversation', () => {
		it('does not leak an abandoned stream error or draft into the next conversation', async () => {
			const hold = deferred<void>();
			let streamDone = false;
			const { user, writes } = setup({
				route: saved,
				streamResponse: () =>
					uiStream(
						[
							{ type: 'start', messageId: 'reply-1' },
							{ type: 'text-start', id: 't1' },
							{ type: 'text-delta', id: 't1', delta: 'Partial' },
						],
						{
							hold: hold.promise,
							rest: [{ type: 'error', errorText: 'Model quota exceeded' }],
							onDone: () => {
								streamDone = true;
							},
						},
					),
			});
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'Long question{Enter}');
			await screen.findByRole('button', { name: 'Stop response' });
			await user.click(screen.getByRole('button', { name: 'Switch conversation' }));
			await waitFor(() =>
				expect(screen.getByTestId('location')).toHaveTextContent('conversation=conversation-2'),
			);
			await act(async () => hold.resolve());
			await waitFor(() => expect(streamDone).toBe(true));
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			expect(textbox()).toHaveValue('');
			expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument();
			// Leaving the tab's view does not stop the server turn.
			expect(writes.map((write) => write.path)).toEqual([streamPath]);
		});

		it('keeps the stop control available while the user types a follow-up', async () => {
			const hold = deferred<void>();
			const { user } = setup({
				route: saved,
				streamResponse: () =>
					uiStream([{ type: 'start', messageId: 'reply-1' }], {
						hold: hold.promise,
						rest: [{ type: 'finish' }],
					}),
			});
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'First{Enter}');
			await screen.findByRole('button', { name: 'Stop response' });
			await user.type(textbox(), 'Second');
			expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Queue message' })).toBeInTheDocument();
			await act(async () => hold.resolve());
		});
	});

	describe('reconnecting to a running reply', () => {
		const pendingRecord = {
			...record,
			pending: { id: 'turn', expires_at: '2099-01-01T00:00:00Z' },
			messages: [
				...record.messages,
				textMessage('user-2', 'user', 'Long task'),
				{
					id: 'reply-1',
					role: 'assistant',
					metadata: { created_at: '2026-10-14T01:01:00Z' },
					parts: [{ type: 'text', text: 'Partial so far', state: 'streaming' }],
				},
			],
		};

		it('replays the live stream from this instance and shows the stop control', async () => {
			const hold = deferred<void>();
			let finished = false;
			const { writes } = setup({
				route: saved,
				detailResponse: () =>
					jsonOk({
						conversation: finished
							? {
									...record,
									messages: [
										...pendingRecord.messages.slice(0, -1),
										textMessage('reply-1', 'assistant', 'Partial so far and done'),
									],
								}
							: pendingRecord,
					}),
				reconnectResponse: () =>
					uiStream(
						[
							{ type: 'start', messageId: 'reply-1' },
							{ type: 'text-start', id: 't1' },
							{ type: 'text-delta', id: 't1', delta: 'Partial so far' },
						],
						{
							hold: hold.promise,
							rest: [
								{ type: 'text-delta', id: 't1', delta: ' and done' },
								{ type: 'text-end', id: 't1' },
								{ type: 'finish' },
							],
							onDone: () => {
								finished = true;
							},
						},
					),
			});
			expect(await screen.findByRole('button', { name: 'Stop response' })).toBeInTheDocument();
			expect(await screen.findAllByText('Partial so far')).toHaveLength(1);
			await act(async () => hold.resolve());
			expect(await screen.findByText('Partial so far and done')).toBeInTheDocument();
			await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled());
			expect(writes).toEqual([]);
		});

		it('replaces the saved partial reply even when the replay uses another message id', async () => {
			const { writes } = setup({
				route: saved,
				detailResponse: () => jsonOk({ conversation: pendingRecord }),
				reconnectResponse: () =>
					uiStream([
						{ type: 'start', messageId: 'reply-renamed' },
						{ type: 'text-start', id: 't1' },
						{ type: 'text-delta', id: 't1', delta: 'Partial so far and done' },
						{ type: 'text-end', id: 't1' },
						{ type: 'finish' },
					]),
			});
			expect(await screen.findByText('Partial so far and done')).toBeInTheDocument();
			expect(screen.queryByText(/^Partial so far$/)).not.toBeInTheDocument();
			expect(screen.getAllByRole('article', { name: 'Assistant message' })).toHaveLength(2);
			expect(writes).toEqual([]);
		});

		it('falls back to the saved record when no instance is streaming', async () => {
			let polls = 0;
			setup({
				route: saved,
				detailResponse: () => {
					polls += 1;
					return jsonOk({
						conversation:
							polls > 2
								? {
										...record,
										messages: [
											...pendingRecord.messages.slice(0, -1),
											textMessage('reply-1', 'assistant', 'Finished elsewhere'),
										],
									}
								: pendingRecord,
					});
				},
			});
			expect(await screen.findByText('Partial so far')).toBeInTheDocument();
			expect(screen.getByText(/Planning the next step|Preparing a response/)).toBeInTheDocument();
			expect(await screen.findByText('Finished elsewhere')).toBeInTheDocument();
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled(),
			);
		});
	});

	describe('notebook pane', () => {
		it('keeps the starting screen for an existing chat with no messages', async () => {
			const { user, writes } = setup({
				route: saved,
				detailResponse: () => jsonOk({ conversation: { ...record, messages: [] } }),
			});
			await screen.findByRole('heading', { name: 'What should we build, Ada?' });
			await user.click(screen.getByRole('button', { name: 'Add context' }));
			await user.click(screen.getByRole('menuitem', { name: 'Open notebook beside chat' }));
			await screen.findByRole('combobox', { name: 'Notebook to open' });
			expect(screen.getByRole('heading', { name: 'What should we build, Ada?' })).toBeVisible();
			await user.type(textbox(), 'Explain this notebook');
			await user.click(screen.getByRole('button', { name: 'Send message' }));
			await waitFor(() => expect(writes.map((write) => write.path)).toEqual([streamPath]));
		});

		it('opens the notebook picker from the empty composer without sending or clearing its draft', async () => {
			const { user, writes } = setup();
			await screen.findByRole('heading', { name: 'What should we build, Ada?' });
			await user.type(textbox(), 'Explain this notebook');
			await user.click(screen.getByRole('button', { name: 'Add context' }));
			expect(writes).toEqual([]);
			await user.click(screen.getByRole('menuitem', { name: 'Open notebook beside chat' }));
			await screen.findByRole('combobox', { name: 'Notebook to open' });
			expect(textbox()).toHaveValue('Explain this notebook');
			expect(writes.map((write) => write.path)).toEqual(['/api/v1/projects/sales/conversations']);
			await user.click(screen.getByRole('button', { name: 'Open notebook' }));
			await screen.findByRole('button', { name: 'Hide notebook Sales report' });
			expect(textbox()).toHaveValue('Explain this notebook');
		});

		it('keeps the draft and reports a failure to open a notebook chat', async () => {
			const { user } = setup({
				createResponse: Promise.resolve(jsonError('UNAVAILABLE', 'Chat unavailable')),
			});
			await screen.findByRole('heading', { name: 'What should we build, Ada?' });
			await user.type(textbox(), 'Keep this question');
			await user.click(screen.getByRole('button', { name: 'Add context' }));
			await user.click(screen.getByRole('menuitem', { name: 'Open notebook beside chat' }));
			expect(await screen.findByRole('alert')).toHaveTextContent('Chat unavailable');
			expect(textbox()).toHaveValue('Keep this question');
			expect(screen.getByRole('button', { name: 'Add context' })).toBeEnabled();
		});

		it('opens the notebook from the composer when the inspector is in front of it', async () => {
			const { user } = setup({
				route: `${saved}&inspect=missing-call`,
				workingNotebook: 'notebook-1',
			});
			await screen.findByText('This tool call is not in this conversation.');
			await user.click(screen.getByRole('button', { name: 'Add context' }));
			await user.click(screen.getByRole('menuitem', { name: 'Open notebook beside chat' }));
			await screen.findByTitle('Notebook Sales report');
			expect(screen.getByTestId('location')).not.toHaveTextContent('inspect=');
			await user.click(screen.getByRole('button', { name: 'Add context' }));
			await user.click(screen.getByRole('menuitem', { name: 'Hide notebook pane' }));
			expect(
				screen.queryByRole('complementary', { name: 'Notebook pane' }),
			).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Show notebook Sales report' })).toBeVisible();
		});

		it('opens the saved working notebook beside the chat and lets the user close or change it', async () => {
			const { user, writes } = setup({ route: saved, workingNotebook: 'notebook-1' });
			const frame = await screen.findByTitle('Notebook Sales report');
			expect(frame).toHaveAttribute('src', '/projects/sales/notebooks/notebook-1');
			await user.click(screen.getByRole('button', { name: 'Change' }));
			await user.selectOptions(
				screen.getByRole('combobox', { name: 'Notebook to open' }),
				'notebook-2',
			);
			await user.click(screen.getByRole('button', { name: 'Open notebook' }));
			await waitFor(() =>
				expect(writes).toContainEqual({
					method: 'PATCH',
					path: '/api/v1/projects/sales/conversations/conversation-1',
					body: { working_notebook: 'notebook-2' },
				}),
			);
			expect(await screen.findByTitle('Notebook Costs')).toBeInTheDocument();
			await user.click(screen.getByRole('button', { name: 'Close notebook pane' }));
			expect(
				screen.queryByRole('complementary', { name: 'Notebook pane' }),
			).not.toBeInTheDocument();
			expect(screen.getByTestId('location')).toHaveTextContent('notebook=0');
			await user.click(screen.getByRole('button', { name: 'Show notebook Costs' }));
			expect(await screen.findByTitle('Notebook Costs')).toBeInTheDocument();
		});

		it('resizes with the keyboard and remembers the width', async () => {
			setup({ route: saved, workingNotebook: 'notebook-1' });
			const divider = await screen.findByRole('separator', { name: 'Notebook pane width' });
			fireEvent.keyDown(divider, { key: 'ArrowLeft' });
			expect(divider).toHaveAttribute('aria-valuenow', '55');
			expect(localStorage.getItem('marimohub.chat.notebook-pane-width')).toBe('55');
		});
	});
});
