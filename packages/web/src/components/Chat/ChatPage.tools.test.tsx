import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { jsonError, jsonOk } from '@/test/render';
import type { setupUser } from '@/test/render';
import {
	deferred,
	installChatPageHooks,
	record,
	saved,
	setup,
	textbox,
	textMessage,
	uiStream,
} from './ChatPage.testWorld';

installChatPageHooks();

describe('ChatPage', () => {
	describe('tool call inspector', () => {
		const withTool = {
			...record,
			messages: [
				...record.messages,
				textMessage('user-2', 'user', 'Create it'),
				{
					id: 'reply-2',
					role: 'assistant',
					metadata: { created_at: '2026-10-14T01:02:00Z' },
					parts: [
						{
							type: 'dynamic-tool',
							toolName: 'create_notebook',
							toolCallId: 'call-9',
							state: 'output-available',
							input: '{\n  "title": "Sales report"\n}',
							output: '{\n  "notebook_id": "notebook-1",\n  "ok": true\n}',
						},
						{ type: 'text', text: 'Done.' },
					],
				},
			],
		};
		const withResource = {
			...withTool,
			messages: [
				...withTool.messages.slice(0, -1),
				{
					id: 'reply-2',
					role: 'assistant',
					metadata: { created_at: '2026-10-14T01:02:00Z' },
					parts: [
						{
							type: 'dynamic-tool',
							toolName: 'create_notebook',
							toolCallId: 'call-9',
							state: 'output-available',
							input: '{\n  "title": "Sales report"\n}',
							output: '{\n  "notebook_id": "nb-0123456789abcdef"\n}',
						},
						{ type: 'text', text: 'Done.' },
					],
				},
			],
		};

		it('opens a call from the transcript, addresses it in the URL, and links its resources', async () => {
			const { user, writes } = setup({
				route: saved,
				detailResponse: () => jsonOk({ conversation: withResource }),
			});
			await screen.findByText('Done.');
			await user.click(screen.getByRole('button', { name: 'Worked · 1 step' }));
			await user.click(screen.getByRole('button', { name: /^Inspect create notebook/ }));
			const details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(screen.getByTestId('location')).toHaveTextContent('inspect=call-9');
			expect(within(details).getByRole('region', { name: 'Input' })).toHaveTextContent(
				'"title": "Sales report"',
			);
			expect(within(details).getByRole('region', { name: 'Result' })).toHaveTextContent(
				'nb-0123456789abcdef',
			);
			expect(
				within(details).getByRole('link', { name: 'Open details in a new tab' }),
			).toHaveAttribute('href', '/projects/sales/chat?conversation=conversation-1&inspect=call-9');
			expect(
				within(details).getByRole('link', { name: 'Open nb-0123456789abcdef in a new tab' }),
			).toHaveAttribute('href', '/projects/sales/notebooks/nb-0123456789abcdef');
			await user.click(within(details).getByRole('button', { name: 'Show beside chat' }));
			await waitFor(() =>
				expect(writes).toContainEqual({
					method: 'PATCH',
					path: '/api/v1/projects/sales/conversations/conversation-1',
					body: { working_notebook: 'nb-0123456789abcdef' },
				}),
			);
			await waitFor(() =>
				expect(
					screen.queryByRole('complementary', { name: 'Tool call details' }),
				).not.toBeInTheDocument(),
			);
			expect(screen.getByTestId('location')).toHaveTextContent('notebook=1');
			expect(screen.getByTestId('location')).not.toHaveTextContent('inspect=');
		});

		it('restores the inspector from the URL and closes it', async () => {
			const { user } = setup({
				route: `${saved}&inspect=call-9`,
				detailResponse: () => jsonOk({ conversation: withTool }),
			});
			const details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(within(details).getByRole('heading', { name: 'create notebook' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /^Inspect create notebook/ })).toHaveAttribute(
				'aria-pressed',
				'true',
			);
			await user.click(within(details).getByRole('button', { name: 'Close details' }));
			expect(
				screen.queryByRole('complementary', { name: 'Tool call details' }),
			).not.toBeInTheDocument();
			expect(screen.getByTestId('location')).not.toHaveTextContent('inspect=');
		});
	});

	describe('tool call inspector edge cases', () => {
		const failedTool = {
			...record,
			messages: [
				...record.messages,
				{
					id: 'reply-3',
					role: 'assistant',
					metadata: { created_at: '2026-10-14T01:03:00Z' },
					parts: [
						{
							type: 'dynamic-tool',
							toolName: 'delete_notebook',
							toolCallId: 'call-denied',
							state: 'output-available',
							input: '{"notebook":"Old"}',
							output: '{"permission":"denied"}',
						},
						{
							type: 'data-permission',
							id: 'perm-denied',
							data: {
								id: 'perm-denied',
								tool_call_id: 'call-denied',
								kind: 'tool',
								action: 'Delete a notebook',
								details: [],
								scope: { key: 'tool:delete_notebook', label: 'deleting notebooks' },
								can_remember: false,
								status: 'denied',
								expires_at: '2099-01-01T00:00:00Z',
							},
						},
						{
							type: 'dynamic-tool',
							toolName: 'run_job',
							toolCallId: 'call-failed',
							state: 'output-error',
							input: '{"job":"job-0123456789abcdef"}',
							errorText: 'NOT_FOUND: Job not found',
						},
						{ type: 'text', text: 'I could not do either.' },
					],
				},
			],
		};

		it('explains a link to a call this conversation does not contain', async () => {
			const { user } = setup({ route: `${saved}&inspect=call-from-elsewhere` });
			await screen.findByText('Persisted project findings');
			const details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(details).toHaveTextContent('This tool call is not in this conversation.');
			await user.click(within(details).getByRole('button', { name: 'Close' }));
			expect(
				screen.queryByRole('complementary', { name: 'Tool call details' }),
			).not.toBeInTheDocument();
			expect(screen.getByTestId('location')).not.toHaveTextContent('inspect=');
		});

		it('does not call a slow-loading conversation missing before it arrives', async () => {
			const pending = deferred<Response>();
			setup({ route: `${saved}&inspect=call-9`, detailResponse: pending.promise });
			await screen.findByText('Loading conversation…');
			expect(
				screen.queryByRole('complementary', { name: 'Tool call details' }),
			).not.toBeInTheDocument();
			await act(async () => pending.resolve(jsonOk({ conversation: record })));
			expect(
				await screen.findByText('This tool call is not in this conversation.'),
			).toBeInTheDocument();
		});

		it('shows a denied consent and a failed call with its error', async () => {
			const { user } = setup({
				route: saved,
				detailResponse: () => jsonOk({ conversation: failedTool }),
			});
			await screen.findByText('I could not do either.');
			await user.click(screen.getByRole('button', { name: /Worked · 2 steps/ }));
			await user.click(screen.getByRole('button', { name: /^Inspect delete notebook/ }));
			let details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(within(details).getByRole('region', { name: 'Permission' })).toHaveTextContent(
				'Not allowed',
			);
			expect(
				within(details).queryByRole('button', { name: 'Show beside chat' }),
			).not.toBeInTheDocument();
			await user.click(screen.getByRole('button', { name: /^Inspect run job/ }));
			details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(within(details).getByText('Failed')).toBeInTheDocument();
			expect(within(details).getByRole('note')).toHaveTextContent('NOT_FOUND: Job not found');
			expect(within(details).getByRole('region', { name: 'Error' })).toHaveTextContent(
				'Nothing saved for this call.',
			);
			expect(
				within(details).getByRole('link', { name: 'Open job-0123456789abcdef in a new tab' }),
			).toHaveAttribute('href', '/projects/sales/jobs');
			expect(screen.getByRole('button', { name: /^Inspect run job/ })).toHaveAttribute(
				'aria-pressed',
				'true',
			);
			expect(screen.getByRole('button', { name: /^Inspect delete notebook/ })).toHaveAttribute(
				'aria-pressed',
				'false',
			);
		});

		it('follows a running call live and keeps the inspector when the result arrives', async () => {
			const hold = deferred<void>();
			let finished = false;
			const final = {
				...record,
				messages: [
					...record.messages,
					textMessage('user-2', 'user', 'Read the sales report'),
					{
						id: 'reply-live',
						role: 'assistant',
						metadata: { created_at: '2026-10-14T01:04:00Z' },
						parts: [
							{
								type: 'dynamic-tool',
								toolName: 'get_notebook',
								toolCallId: 'live-1',
								state: 'output-error',
								input: '{"notebook":"Sales report"}',
								errorText: 'FORBIDDEN: No access',
							},
							{ type: 'text', text: 'I cannot read it.' },
						],
					},
				],
			};
			const { user } = setup({
				route: saved,
				detailResponse: () => jsonOk({ conversation: finished ? final : record }),
				streamResponse: () =>
					uiStream(
						[
							{ type: 'start', messageId: 'reply-live' },
							{
								type: 'tool-input-start',
								toolCallId: 'live-1',
								toolName: 'get_notebook',
								dynamic: true,
							},
							{
								type: 'tool-input-available',
								toolCallId: 'live-1',
								toolName: 'get_notebook',
								input: '{"notebook":"Sales report"}',
								dynamic: true,
							},
						],
						{
							hold: hold.promise,
							rest: [
								{
									type: 'tool-output-error',
									toolCallId: 'live-1',
									errorText: 'FORBIDDEN: No access',
									dynamic: true,
								},
								{ type: 'text-start', id: 't1' },
								{ type: 'text-delta', id: 't1', delta: 'I cannot read it.' },
								{ type: 'text-end', id: 't1' },
								{ type: 'finish' },
							],
							onDone: () => {
								finished = true;
							},
						},
					),
			});
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'Read the sales report{Enter}');
			await user.click(await screen.findByRole('button', { name: /^Inspect get notebook/ }));
			const details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(within(details).getByText('Running')).toBeInTheDocument();
			expect(within(details).getByRole('region', { name: 'Result' })).toHaveTextContent(
				'Nothing saved for this call.',
			);
			await act(async () => hold.resolve());
			await screen.findByText('I cannot read it.');
			expect(within(details).getByText('Failed')).toBeInTheDocument();
			expect(within(details).getByRole('note')).toHaveTextContent('FORBIDDEN: No access');
		});

		it('keeps the inspector open and reports when a notebook cannot be shown beside the chat', async () => {
			const withResource = {
				...record,
				messages: [
					...record.messages,
					{
						id: 'reply-2',
						role: 'assistant',
						metadata: { created_at: '2026-10-14T01:02:00Z' },
						parts: [
							{
								type: 'dynamic-tool',
								toolName: 'create_notebook',
								toolCallId: 'call-9',
								state: 'output-available',
								input: '{}',
								output: '{"notebook_id":"nb-0123456789abcdef"}',
							},
						],
					},
				],
			};
			const { user, writes } = setup({
				route: `${saved}&inspect=call-9`,
				detailResponse: () => jsonOk({ conversation: withResource }),
				patchResponse: () => jsonError('NOT_FOUND', 'Notebook was deleted', 404),
			});
			const details = await screen.findByRole('complementary', { name: 'Tool call details' });
			await user.click(within(details).getByRole('button', { name: 'Show beside chat' }));
			expect(await screen.findByRole('alert')).toHaveTextContent('Notebook was deleted');
			expect(writes.filter((write) => write.method === 'PATCH')).toHaveLength(1);
			expect(screen.getByRole('complementary', { name: 'Tool call details' })).toBeInTheDocument();
			expect(screen.getByTestId('location')).toHaveTextContent('inspect=call-9');
			expect(screen.getByTestId('location')).not.toHaveTextContent('notebook=1');
		});

		it('takes precedence over the notebook pane and gives it back on close', async () => {
			const withTool = {
				...record,
				working_notebook: 'notebook-1',
				messages: [
					...record.messages,
					{
						id: 'reply-2',
						role: 'assistant',
						metadata: { created_at: '2026-10-14T01:02:00Z' },
						parts: [
							{
								type: 'dynamic-tool',
								toolName: 'get_notebook',
								toolCallId: 'call-9',
								state: 'output-available',
								input: '{}',
								output: '{}',
							},
						],
					},
				],
			};
			const { user } = setup({
				route: saved,
				detailResponse: () => jsonOk({ conversation: withTool }),
			});
			await screen.findByTitle('Notebook Sales report');
			await user.click(screen.getByRole('button', { name: 'Worked · 1 step' }));
			await user.click(screen.getByRole('button', { name: /^Inspect get notebook/ }));
			await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(
				screen.queryByRole('complementary', { name: 'Notebook pane' }),
			).not.toBeInTheDocument();
			await user.click(screen.getByRole('button', { name: 'Close details' }));
			expect(await screen.findByTitle('Notebook Sales report')).toBeInTheDocument();
		});
	});

	describe('search message deep links', () => {
		it('reveals the matched message after conversation loading', async () => {
			const reveal = vi.fn();
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
				value: reveal,
				configurable: true,
			});
			try {
				setup({ route: `${saved}&message=message-1` });
				await screen.findByText('Persisted project findings');
				await waitFor(() => expect(reveal).toHaveBeenCalledWith({ block: 'center' }));
				expect(document.getElementById('chat-message-message-1')).toHaveTextContent(
					'Persisted project findings',
				);
			} finally {
				Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
			}
		});
	});

	describe('last conversation per tab', () => {
		const STORAGE_KEY = 'marimohub.chat.last-conversation.sales';
		const location = () => screen.getByTestId('location');
		const blockStorage = (method: 'getItem' | 'setItem') =>
			vi.spyOn(Storage.prototype, method).mockImplementation(() => {
				throw new DOMException('blocked', 'SecurityError');
			});
		async function openSaved() {
			const rendered = setup({ route: saved });
			await screen.findByText('Persisted project findings');
			return rendered;
		}
		async function leaveAndReturn(user: ReturnType<typeof setupUser>) {
			await user.click(screen.getByRole('button', { name: 'Leave chat' }));
			await screen.findByText('Jobs');
			await user.click(screen.getByRole('button', { name: 'Return to chat' }));
			await screen.findByRole('button', { name: 'History' });
		}
		afterEach(() => vi.restoreAllMocks());

		it('reopens the conversation that was open when the user left the chat', async () => {
			const { user } = await openSaved();
			await leaveAndReturn(user);
			expect(await screen.findByText('Persisted project findings')).toBeInTheDocument();
			expect(location()).toHaveTextContent('conversation=conversation-1');
		});

		it('returns to home when the user left from home', async () => {
			const { user } = await openSaved();
			await user.click(screen.getByRole('button', { name: 'New chat' }));
			await waitFor(() => expect(location()).not.toHaveTextContent('conversation='));
			await leaveAndReturn(user);
			expect(location()).toHaveTextContent('/projects/sales/chat');
			expect(location()).not.toHaveTextContent('conversation=');
		});

		it('does not carry a remembered conversation into another project', async () => {
			const { user } = await openSaved();
			await user.click(screen.getByRole('button', { name: 'Switch project' }));
			await screen.findByText('Finance');
			await screen.findByRole('button', { name: 'History' });
			expect(location()).toHaveTextContent('/projects/finance/chat');
			expect(location()).not.toHaveTextContent('conversation=');
		});

		it('keeps an explicit conversation in the URL over the remembered one', async () => {
			sessionStorage.setItem(STORAGE_KEY, 'conversation-other');
			await openSaved();
			expect(location()).toHaveTextContent('conversation=conversation-1');
		});

		it('forgets a remembered conversation that no longer loads', async () => {
			sessionStorage.setItem(STORAGE_KEY, 'conversation-gone');
			const { user } = setup({
				detailResponse: () => jsonError('NOT_FOUND', 'Conversation not found', 404),
			});
			await screen.findByText('Conversation not found');
			expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
			await leaveAndReturn(user);
			expect(location()).not.toHaveTextContent('conversation=');
		});

		it('shows home when session storage is unavailable', async () => {
			blockStorage('getItem');
			blockStorage('setItem');
			setup();
			await screen.findByRole('button', { name: 'History' });
			expect(location()).not.toHaveTextContent('conversation=');
		});
	});

	describe('tool consent', () => {
		const permissionRequest = {
			id: 'permission-1',
			tool_call_id: 'create-call',
			kind: 'tool',
			action: 'Create a notebook',
			details: [{ label: 'Title', value: 'Revenue' }],
			scope: { key: 'tool:create_notebook', label: 'creating notebooks in this project' },
			can_remember: true,
			status: 'open',
			expires_at: '2099-01-01T00:00:00Z',
		};

		it('renders streamed permissions, posts the decision, and updates the card in place', async () => {
			const release = deferred<void>();
			let saved = record;
			const { user, writes } = setup({
				route: '/projects/sales/chat?conversation=conversation-1',
				detailResponse: () => jsonOk({ conversation: saved }),
				streamResponse: () =>
					uiStream(
						[
							{ type: 'start', messageId: 'permission-reply' },
							{
								type: 'tool-input-available',
								toolCallId: 'create-call',
								toolName: 'create_notebook',
								input: '{"title":"Revenue"}',
								dynamic: true,
							},
							{ type: 'data-permission', id: permissionRequest.id, data: permissionRequest },
						],
						{
							hold: release.promise,
							rest: [
								{
									type: 'data-permission',
									id: permissionRequest.id,
									data: { ...permissionRequest, status: 'allowed' },
								},
								{
									type: 'tool-output-available',
									toolCallId: 'create-call',
									output: '{"notebook_id":"notebook-3"}',
									dynamic: true,
								},
								{ type: 'text-start', id: 't1' },
								{ type: 'text-delta', id: 't1', delta: 'Created it.' },
								{ type: 'text-end', id: 't1' },
								{ type: 'finish' },
							],
						},
					),
			});
			await screen.findByText('Persisted project findings');
			await user.type(textbox(), 'Create a notebook');
			await user.click(screen.getByRole('button', { name: 'Send message' }));
			expect(await screen.findByText('Waiting for your permission…')).toBeInTheDocument();
			expect(
				screen.getByRole('button', { name: 'Always allow creating notebooks in this project' }),
			).toBeInTheDocument();
			await user.click(screen.getByRole('button', { name: 'Allow once' }));
			await waitFor(() =>
				expect(writes).toContainEqual({
					method: 'POST',
					path: '/api/v1/projects/sales/conversations/conversation-1/permissions/permission-1',
					body: { decision: 'allow' },
				}),
			);
			saved = {
				...record,
				messages: [
					{
						id: 'permission-reply',
						role: 'assistant',
						metadata: { created_at: record.created_at },
						parts: [
							{
								type: 'dynamic-tool',
								toolName: 'create_notebook',
								toolCallId: 'create-call',
								state: 'output-available',
								input: '{"title":"Revenue"}',
								output: '{"notebook_id":"notebook-3"}',
							},
							{
								type: 'data-permission',
								id: permissionRequest.id,
								data: { ...permissionRequest, status: 'allowed' },
							},
							{ type: 'text', text: 'Created it.' },
						],
					},
				],
			};
			act(() => release.resolve());
			await screen.findByText('Allowed once');
			await screen.findByText('Created it.');
			await user.click(await screen.findByRole('button', { name: 'Worked · 1 step' }));
			await waitFor(() =>
				expect(screen.getAllByRole('region', { name: 'Tool permission' })).toHaveLength(1),
			);
		});

		it('restores an open permission card from a saved conversation and hides "always" for irreversible actions', async () => {
			setup({
				route: saved,
				detailResponse: () =>
					jsonOk({
						conversation: {
							...record,
							pending: { id: 'turn', expires_at: '2099-01-01T00:00:00Z' },
							messages: [
								{
									id: 'saved-permission',
									role: 'assistant',
									metadata: { created_at: record.created_at },
									parts: [
										{
											type: 'dynamic-tool',
											toolName: 'delete_notebook',
											toolCallId: 'saved-call',
											state: 'input-available',
											input: '{"notebook":"Old"}',
										},
										{
											type: 'data-permission',
											id: permissionRequest.id,
											data: {
												...permissionRequest,
												tool_call_id: 'saved-call',
												action: 'Delete a notebook',
												can_remember: false,
											},
										},
									],
								},
							],
						},
					}),
			});
			expect(await screen.findByRole('button', { name: 'Allow once' })).toBeEnabled();
			expect(screen.queryByRole('button', { name: /Always allow/ })).not.toBeInTheDocument();
			expect(screen.getByText('Delete a notebook')).toBeInTheDocument();
		});
	});
});
