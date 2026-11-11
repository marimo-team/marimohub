import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { installMatchMedia, jsonError, jsonOk, renderWithClient, setupUser } from '@/test/render';
import { makeCapabilities } from '@/test/apiStub';
import { ChatPage } from './ChatPage';

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function textMessage(id: string, role: 'user' | 'assistant', text: string) {
	return {
		id,
		role,
		metadata: { created_at: '2026-10-14T01:00:00Z' },
		parts: [{ type: 'text', text }],
	};
}

export const record = {
	schema_version: 1,
	id: 'conversation-1',
	title: 'Saved investigation',
	created_at: '2026-10-14T01:00:00Z',
	updated_at: '2026-10-14T01:00:00Z',
	messages: [textMessage('message-1', 'assistant', 'Persisted project findings')] as unknown[],
};
export const replyChunks = [
	{ type: 'start', messageId: 'reply-1' },
	{ type: 'text-start', id: 't1' },
	{ type: 'text-delta', id: 't1', delta: 'Live project answer' },
	{ type: 'text-end', id: 't1' },
	{ type: 'finish' },
];

/** Builds an AI SDK UI message SSE response; with `hold` it pauses before `rest`. */
export function uiStream(
	chunks: unknown[],
	options: { hold?: Promise<void>; rest?: unknown[]; onDone?: () => void } = {},
): Response {
	const encoder = new TextEncoder();
	const encode = (chunk: unknown) =>
		encoder.encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for (const chunk of chunks) controller.enqueue(encode(chunk));
				if (options.hold) {
					await options.hold;
					for (const chunk of options.rest ?? []) controller.enqueue(encode(chunk));
				}
				controller.enqueue(encode('[DONE]'));
				controller.close();
			} catch {
				// The consumer cancelled the stream (stop, or leaving the conversation).
			} finally {
				options.onDone?.();
			}
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

export interface Write {
	method: string;
	path: string;
	body: unknown;
}

export function setup(
	options: {
		route?: string;
		listFails?: boolean;
		detailResponse?: Promise<Response> | Response | ((cid: string) => Response | Promise<Response>);
		conversations?: { id: string; title: string }[];
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
			if (path === '/api/v1/me') return jsonOk({ id: 'user-1', name: 'Ada Lovelace' });
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
				return jsonOk({
					conversations: deleted
						? []
						: (options.conversations ?? [record]).map((item) => ({
								...record,
								...item,
								message_count: 1,
							})),
				});
			}
			if (path.includes('/conversations/'))
				return (
					(typeof options.detailResponse === 'function'
						? options.detailResponse(path.split('/').at(-1)!)
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
	return { ...rendered, user: setupUser(), writes };
}

export const textbox = () => screen.getByRole('textbox', { name: 'Message the project assistant' });
export const streamPath = '/api/v1/projects/sales/conversations/conversation-1/stream';
export const stopPath = '/api/v1/projects/sales/conversations/conversation-1/stop';
export const saved = '/projects/sales/chat?conversation=conversation-1';

export function installChatPageHooks() {
	beforeAll(() =>
		Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
			value: vi.fn(),
			configurable: true,
		}),
	);
	afterAll(() => Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo'));
	beforeEach(() => {
		installMatchMedia();
		sessionStorage.clear();
		localStorage.clear();
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe = vi.fn();
				unobserve = vi.fn();
				disconnect = vi.fn();
			},
		);
	});
	afterEach(() => vi.unstubAllGlobals());
}
