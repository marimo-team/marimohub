import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { makeCapabilities } from '@/test/apiStub';
import { notebookKeys } from '@/api/queryKeys';
import { ChatPage } from './ChatPage';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function textMessage(id: string, role: 'user' | 'assistant', text: string) {
	return {
		id,
		role,
		metadata: { created_at: '2026-10-14T01:00:00Z' },
		parts: [{ type: 'text', text }],
	};
}

const record = {
	schema_version: 1,
	id: 'conversation-1',
	title: 'Saved investigation',
	created_at: '2026-10-14T01:00:00Z',
	updated_at: '2026-10-14T01:00:00Z',
	messages: [textMessage('message-1', 'assistant', 'Persisted project findings')] as unknown[],
};
const replyChunks = [
	{ type: 'start', messageId: 'reply-1' },
	{ type: 'text-start', id: 't1' },
	{ type: 'text-delta', id: 't1', delta: 'Live project answer' },
	{ type: 'text-end', id: 't1' },
	{ type: 'finish' },
];

/** Builds an AI SDK UI message SSE response; with `hold` it pauses before `rest`. */
function uiStream(
	chunks: unknown[],
	options: { hold?: Promise<void>; rest?: unknown[]; onDone?: () => void } = {},
): Response {
	const encoder = new TextEncoder();
	const encode = (chunk: unknown) =>
		encoder.encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) controller.enqueue(encode(chunk));
			if (options.hold) {
				await options.hold;
				for (const chunk of options.rest ?? []) controller.enqueue(encode(chunk));
			}
			controller.enqueue(encode('[DONE]'));
			options.onDone?.();
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'x-vercel-ai-ui-message-stream': 'v1',
		},
	});
}

function LocationProbe() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<output data-testid="location">
				{location.pathname}
				{location.search}
			</output>
			<button onClick={() => void navigate('/projects/finance/chat')}>Switch project</button>
			<button onClick={() => void navigate('/projects/sales/chat?conversation=conversation-2')}>
				Switch conversation
			</button>
			<button onClick={() => void navigate('/projects/sales/jobs')}>Leave chat</button>
			<button onClick={() => void navigate('/projects/sales/chat')}>Return to chat</button>
		</>
	);
}

interface Write {
	method: string;
	path: string;
	body: unknown;
}

function setup(
	options: {
		route?: string;
		listFails?: boolean;
		detailResponse?: Promise<Response> | Response | (() => Response | Promise<Response>);
		createResponse?: Promise<Response>;
		streamResponse?: Promise<Response> | (() => Response | Promise<Response>);
		reconnectResponse?: () => Response;
		patchResponse?: () => Response;
		workingNotebook?: string;
	} = {},
) {
	const writes: Write[] = [];
	let listRequests = 0;
	let current: typeof record & { working_notebook?: string } = {
		...record,
		...(options.workingNotebook ? { working_notebook: options.workingNotebook } : {}),
	};
	let deleted = false;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request
					? input
					: new Request(new URL(String(input), window.location.origin), init);
			const path = new URL(request.url).pathname;
			if (request.method === 'GET' && path.endsWith('/stream'))
				return options.reconnectResponse?.() ?? new Response(null, { status: 204 });
			if (request.method !== 'GET') {
				const bodyless = request.method === 'DELETE' || /\/(stop|dismiss)$/.test(path);
				writes.push({ method: request.method, path, body: bodyless ? null : await request.json() });
				if (request.method === 'DELETE') {
					deleted = true;
					return jsonOk({ deleted: true });
				}
				if (request.method === 'PATCH') {
					if (options.patchResponse) return options.patchResponse();
					const body = writes.at(-1)!.body as { working_notebook: string | null };
					current = { ...current, working_notebook: body.working_notebook ?? undefined };
					return jsonOk({ conversation: current });
				}
				if (path.endsWith('/stop')) return jsonOk({ stopped: true });
				if (path.endsWith('/dismiss')) return jsonOk({ conversation: current });
				if (path.includes('/permissions/')) return jsonOk({ accepted: true });
				if (path.endsWith('/conversations'))
					return options.createResponse ?? jsonOk({ conversation: current });
				if (path.endsWith('/stream')) {
					if (typeof options.streamResponse === 'function') return options.streamResponse();
					if (options.streamResponse) return options.streamResponse;
					const completed = {
						...record,
						messages: [
							...record.messages,
							textMessage('user-2', 'user', 'What notebooks are here?'),
							textMessage('reply-1', 'assistant', 'Live project answer'),
						],
					};
					return uiStream(replyChunks, {
						onDone: () => {
							current = completed;
						},
					});
				}
			}
			if (path.endsWith('/capabilities'))
				return jsonOk(makeCapabilities({ chat: { available: true }, jobs: { available: true } }));
			if (path.endsWith('/chat-permissions')) return jsonOk({ grants: [] });
			if (path.endsWith('/notebooks'))
				return jsonOk({
					items: [
						{ id: 'notebook-1', title: 'Sales report' },
						{ id: 'notebook-2', title: 'Costs' },
					],
					next_cursor: null,
				});
			if (path.endsWith('/conversations')) {
				listRequests += 1;
				if (options.listFails && listRequests === 1)
					return jsonError('INTERNAL_ERROR', 'History unavailable');
				return jsonOk({ conversations: deleted ? [] : [{ ...record, message_count: 1 }] });
			}
			if (path.includes('/conversations/'))
				return (
					(typeof options.detailResponse === 'function'
						? options.detailResponse()
						: options.detailResponse) ?? jsonOk({ conversation: current })
				);
			return jsonOk({
				id: path.split('/').at(-1),
				name: path.includes('finance') ? 'Finance' : 'Sales',
				description: '',
				your_role: 'manager',
			});
		}),
	);
	const rendered = renderWithClient(
		<>
			<Routes>
				<Route path="/projects/:pid/chat" element={<ChatPage />} />
				<Route path="/projects/:pid/jobs" element={<p>Jobs</p>} />
			</Routes>
			<LocationProbe />
		</>,
		{ route: options.route ?? '/projects/sales/chat' },
	);
	return { ...rendered, user: userEvent.setup(), writes };
}

const textbox = () => screen.getByRole('textbox', { name: 'Message the project assistant' });
const streamPath = '/api/v1/projects/sales/conversations/conversation-1/stream';
const stopPath = '/api/v1/projects/sales/conversations/conversation-1/stop';
const saved = '/projects/sales/chat?conversation=conversation-1';

beforeAll(() =>
	Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true }),
);
afterAll(() => Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo'));
beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe = vi.fn();
			disconnect = vi.fn();
		},
	);
});
afterEach(() => vi.unstubAllGlobals());

describe('ChatPage', () => {
	it('starts a conversation from home, streams the reply, and refreshes project data', async () => {
		const { user, writes, client } = setup();
		client.setQueryData(notebookKeys.detail('sales', 'existing'), { title: 'Cached notebook' });
		client.setQueryData(notebookKeys.detail('finance', 'existing'), { title: 'Other notebook' });
		await screen.findByRole('heading', { name: 'What would you like to do?' });
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
		const { user, writes } = setup({
			route: saved,
			detailResponse: jsonOk({
				conversation: {
					...record,
					continuation: {
						status: 'needs_review',
						reason: 'interrupted',
						task: 'Create a notebook',
						observations: [],
						unresolved_calls: [{ id: 'call-1', name: 'execute_code' }],
					},
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
			detailResponse: jsonOk({
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
				client.setQueryData(['conversations', 'sales', record.id], {
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
		const history = await screen.findByRole('dialog', { name: 'Your conversations' });
		await user.click(within(history).getByRole('button', { name: /^Saved investigation/ }));
		expect(await screen.findByText('Persisted project findings')).toBeInTheDocument();
		expect(screen.getByTestId('location')).toHaveTextContent('conversation=conversation-1');
		await user.click(screen.getByRole('button', { name: 'History' }));
		await user.click(
			within(screen.getByRole('dialog', { name: 'Your conversations' })).getByRole('button', {
				name: 'Delete conversation Saved investigation',
			}),
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
						: jsonError('NOT_FOUND', 'Conversation missing', 404),
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
		await screen.findByRole('heading', { name: 'What would you like to do?' });
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
		await act(async () => pending.resolve(jsonOk({ conversation: record })));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(writes.map((write) => write.path)).toEqual(['/api/v1/projects/sales/conversations']);
		expect(screen.getByTestId('location')).toHaveTextContent('/projects/finance/chat');
		expect(screen.getByTestId('location')).not.toHaveTextContent('conversation=');
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
		async function startTurn(user: ReturnType<typeof userEvent.setup>) {
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
			const key = ['conversations', 'sales', 'conversation-1'];
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
			expect(screen.getAllByText('Partial so far')).toHaveLength(1);
			await act(async () => hold.resolve());
			expect(await screen.findByText('Partial so far and done')).toBeInTheDocument();
			await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled());
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
			expect(
				await screen.findByText('Finished elsewhere', undefined, { timeout: 6000 }),
			).toBeInTheDocument();
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled(),
			);
		}, 10_000);
	});

	describe('notebook pane', () => {
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
			await user.click(screen.getByRole('button', { name: 'Notebook' }));
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
			await user.click(screen.getByRole('button', { name: 'Inspect create notebook' }));
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
			expect(screen.getByRole('button', { name: 'Inspect create notebook' })).toHaveAttribute(
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
			await user.click(screen.getByRole('button', { name: 'Inspect delete notebook' }));
			let details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(within(details).getByRole('region', { name: 'Permission' })).toHaveTextContent(
				'Not allowed',
			);
			expect(
				within(details).queryByRole('button', { name: 'Show beside chat' }),
			).not.toBeInTheDocument();
			await user.click(screen.getByRole('button', { name: 'Inspect run job' }));
			details = await screen.findByRole('complementary', { name: 'Tool call details' });
			expect(within(details).getByText('Failed')).toBeInTheDocument();
			expect(within(details).getByRole('note')).toHaveTextContent('NOT_FOUND: Job not found');
			expect(within(details).getByRole('region', { name: 'Error' })).toHaveTextContent(
				'Nothing saved for this call.',
			);
			expect(
				within(details).getByRole('link', { name: 'Open job-0123456789abcdef in a new tab' }),
			).toHaveAttribute('href', '/projects/sales/jobs');
			expect(screen.getByRole('button', { name: 'Inspect run job' })).toHaveAttribute(
				'aria-pressed',
				'true',
			);
			expect(screen.getByRole('button', { name: 'Inspect delete notebook' })).toHaveAttribute(
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
			await user.click(await screen.findByRole('button', { name: 'Inspect get notebook' }));
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
			await user.click(screen.getByRole('button', { name: 'Inspect get notebook' }));
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
		async function leaveAndReturn(user: ReturnType<typeof userEvent.setup>) {
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
			await waitFor(() =>
				expect(screen.getAllByRole('region', { name: 'Tool permission' })).toHaveLength(1),
			);
		});

		it('restores an open permission card from a saved conversation and hides "always" for irreversible actions', async () => {
			setup({
				route: saved,
				detailResponse: jsonOk({
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
