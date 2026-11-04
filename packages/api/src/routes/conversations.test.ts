import { describe, expect, it, vi } from 'vitest';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { UserId } from '@marimo-hub/core';
import { messageText } from '@marimo-hub/core/chat';
import type { Conversation, ConversationPermission } from '@marimo-hub/core/chat';
import { DEFAULT_CHAT_CONFIG } from '../context';
import type { ApiDeps } from '../context';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';

interface ConversationResult {
	conversation: Conversation;
}

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function finish(unified: 'stop' | 'tool-calls' | 'length'): LanguageModelV3StreamPart {
	return { type: 'finish', finishReason: { unified, raw: unified }, usage: USAGE };
}

function textStream(text: string): LanguageModelV3StreamResult {
	return {
		stream: simulateReadableStream<LanguageModelV3StreamPart>({
			chunks: [
				{ type: 'text-start', id: 't' },
				{ type: 'text-delta', id: 't', delta: text },
				{ type: 'text-end', id: 't' },
				finish('stop'),
			],
		}),
	};
}

function toolCallStream(
	toolName: string,
	input: Record<string, unknown>,
): LanguageModelV3StreamResult {
	return {
		stream: simulateReadableStream<LanguageModelV3StreamPart>({
			chunks: [
				{
					type: 'tool-call',
					toolCallId: `call-${toolName}`,
					toolName,
					input: JSON.stringify(input),
				},
				finish('tool-calls'),
			],
		}),
	};
}

/** A stream that never ends until the SDK cancels it (aborted turns). */
function hangingStream(onCancel?: () => void): LanguageModelV3StreamResult {
	return {
		stream: new ReadableStream<LanguageModelV3StreamPart>({
			start(controller) {
				controller.enqueue({ type: 'text-start', id: 't' });
				controller.enqueue({ type: 'text-delta', id: 't', delta: 'Working' });
			},
			cancel: onCancel,
		}),
	};
}

function aiDeps(
	model: MockLanguageModelV3,
	overrides: Partial<NonNullable<ApiDeps['ai']>> = {},
): Pick<ApiDeps, 'ai'> {
	return {
		ai: {
			upstreamBaseUrl: 'https://provider.example/v1',
			upstreamApiKey: 'provider-secret',
			model: 'configured-model',
			signingSecret: 'signing-secret',
			languageModel: model,
			chat: DEFAULT_CHAT_CONFIG,
			...overrides,
		},
	};
}

async function fixture(
	doStream: ConstructorParameters<typeof MockLanguageModelV3>[0] extends infer T
		? T extends { doStream?: infer D }
			? D
			: never
		: never,
	options: {
		bucket?: MemoryBucket;
		userId?: UserId;
		ai?: Partial<NonNullable<ApiDeps['ai']>>;
	} = {},
) {
	const bucket = options.bucket ?? (await createInitializedBucket());
	const model = new MockLanguageModelV3({ modelId: 'configured-model', doStream });
	const api = createTestApi({
		bucket,
		userId: options.userId,
		deps: aiDeps(model, options.ai),
	});
	return { ...api, model };
}

async function createProject(request: ReturnType<typeof createTestApi>['request']) {
	const project = await expectOk<{ id: string }>(
		await request('POST', '/projects', { name: 'Sales', description: 'Sales analysis' }),
		201,
	);
	return project.id;
}

async function startConversation(
	request: ReturnType<typeof createTestApi>['request'],
	pid: string,
) {
	const { conversation } = await expectOk<ConversationResult>(
		await request('POST', `/projects/${pid}/conversations`, {}),
	);
	return `/projects/${pid}/conversations/${conversation.id}`;
}

/** Parse an AI SDK UI message SSE body into its chunks. */
async function readChunks(response: Response): Promise<Record<string, unknown>[]> {
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('text/event-stream');
	const text = await response.text();
	return text
		.split('\n\n')
		.filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
		.map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

/** Poll the saved record until `predicate` holds (the turn runs in the background). */
async function waitForRecord(
	request: ReturnType<typeof createTestApi>['request'],
	path: string,
	predicate: (conversation: Conversation) => boolean,
): Promise<Conversation> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const { conversation } = await expectOk<ConversationResult>(await request('GET', path));
		if (predicate(conversation)) return conversation;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('The conversation never reached the expected state');
}

function openCard(conversation: Conversation): ConversationPermission | undefined {
	const part = conversation.messages.at(-1)?.parts.find((part) => part.type === 'data-permission');
	return part?.type === 'data-permission' ? part.data : undefined;
}

function permissionChunks(chunks: Record<string, unknown>[]): ConversationPermission[] {
	return chunks
		.filter((chunk) => chunk.type === 'data-permission')
		.map((chunk) => chunk.data as ConversationPermission);
}

describe('project conversations', () => {
	it('is unavailable without a configured chat model', async () => {
		const bucket = await createInitializedBucket();
		const api = createTestApi({ bucket });
		const pid = await createProject(api.request);
		await expectError(await api.request('GET', `/projects/${pid}/conversations`), 404);
		const capabilities = await expectOk<{ chat: { available: boolean } }>(
			await api.request('GET', '/capabilities'),
		);
		expect(capabilities.chat).toEqual({ available: false });
	});

	it('keeps conversations private to their owner and to human identities', async () => {
		const { request, bucket } = await fixture(textStream('hi'));
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const outsider = createTestApi({
			bucket,
			userId: UserId.parse('other'),
			deps: aiDeps(new MockLanguageModelV3({})),
		});
		await expectError(await outsider.request('GET', `/projects/${pid}/conversations`), 404);
		const viewer = createTestApi({
			bucket,
			userId: UserId.parse('other'),
			deps: { ...aiDeps(new MockLanguageModelV3({})), policy: { defaultRole: 'viewer' } },
		});
		await expectError(await viewer.request('GET', path), 404);
		await expectError(await viewer.request('DELETE', path), 404);
		await expectError(await viewer.request('POST', `${path}/messages`, { content: 'hello' }), 404);
		expect(
			(
				await expectOk<{ conversations: unknown[] }>(
					await viewer.request('GET', `/projects/${pid}/conversations`),
				)
			).conversations,
		).toEqual([]);
		const machine = createTestApi({
			bucket,
			subject: { credential: { kind: 'service-account' } },
			deps: aiDeps(new MockLanguageModelV3({})),
		});
		await expectError(await machine.request('GET', `/projects/${pid}/conversations`), 403);
	});

	it('lets no other user mutate, stop, answer, or re-attach to a private conversation', async () => {
		const { request, bucket } = await fixture([hangingStream(), textStream('x')]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const streaming = request('POST', `${path}/stream`, { content: 'long task' });
		await waitForRecord(request, path, (c) => Boolean(c.pending));
		const other = createTestApi({
			bucket,
			userId: UserId.parse('other'),
			deps: { ...aiDeps(new MockLanguageModelV3({})), policy: { defaultRole: 'editor' } },
		});
		// An editor sees the project, but never another person's conversation.
		await expectError(await other.request('GET', path), 404);
		await expectError(await other.request('POST', `${path}/stop`), 404);
		await expectError(await other.request('GET', `${path}/stream`), 404);
		await expectError(await other.request('PATCH', path, { working_notebook: null }), 404);
		await expectError(await other.request('POST', `${path}/continuation/dismiss`), 404);
		await expectError(
			await other.request('POST', `${path}/permissions/${crypto.randomUUID()}`, {
				decision: 'allow',
			}),
			404,
		);
		await expectError(await other.request('DELETE', path), 404);
		// The owner's turn is untouched by all of that.
		expect(
			(await expectOk<ConversationResult>(await request('GET', path))).conversation.pending,
		).toBeDefined();
		await expectOk(await request('POST', `${path}/stop`));
		await readChunks(await streaming);
	});

	it('closes stale consent answers and ignores unknown request ids', async () => {
		const { request } = await fixture([textStream('plain')]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		await expectOk(await request('POST', `${path}/messages`, { content: 'hello' }));
		expect(
			await expectOk(
				await request('POST', `${path}/permissions/${crypto.randomUUID()}`, { decision: 'allow' }),
			),
		).toEqual({ accepted: false, reason: 'closed' });
		await expectError(
			await request('POST', `${path}/permissions/${crypto.randomUUID()}`, { decision: 'maybe' }),
			422,
		);
	});

	it('streams the reply, persists it, and never exposes provider credentials', async () => {
		const { request, model } = await fixture(textStream('Project overview'));
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const chunks = await readChunks(
			await request('POST', `${path}/stream`, { content: 'What is this project?' }),
		);
		expect(chunks.map((chunk) => chunk.type)).toEqual([
			'start',
			'message-metadata',
			'start-step',
			'text-start',
			'text-delta',
			'text-end',
			'finish-step',
			'finish',
		]);
		const saved = await expectOk<ConversationResult>(await request('GET', path));
		expect(saved.conversation.messages.map(messageText)).toEqual([
			'What is this project?',
			'Project overview',
		]);
		expect(saved.conversation.title).toBe('What is this project?');
		expect(saved.conversation.pending).toBeUndefined();
		expect(JSON.stringify(saved)).not.toContain('provider-secret');
		expect(model.doStreamCalls).toHaveLength(1);
		const call = model.doStreamCalls[0];
		expect(call.maxOutputTokens).toBe(8192);
		const prompt = JSON.stringify(call.prompt);
		expect(prompt).toContain('Sales analysis');
		expect(prompt).toContain('What is this project?');
		expect(prompt).not.toContain('provider-secret');
		expect(call.tools?.map((tool) => tool.name)).toContain('list_catalog');
		const list = await expectOk<{ conversations: { message_count: number }[] }>(
			await request('GET', `/projects/${pid}/conversations`),
		);
		expect(list.conversations[0]).toMatchObject({ message_count: 2 });
		expect(list.conversations[0]).not.toHaveProperty('messages');
	});

	it('answers the blocking endpoint and refuses overlapping turns', async () => {
		const { request } = await fixture([textStream('First'), textStream('Second')]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const result = await expectOk<ConversationResult>(
			await request('POST', `${path}/messages`, { content: 'hello' }),
		);
		expect(messageText(result.conversation.messages.at(-1)!)).toBe('First');
		await expectError(await request('POST', `${path}/resume`, {}), 409);
		const again = await expectOk<ConversationResult>(
			await request('POST', `${path}/messages`, { content: 'again' }),
		);
		expect(again.conversation.messages).toHaveLength(4);
	});

	it('runs read-only tools without consent and records redacted previews', async () => {
		const { request, model } = await fixture([
			toolCallStream('list_catalog', { q: 'sales' }),
			textStream('Found nothing yet.'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const chunks = await readChunks(await request('POST', `${path}/stream`, { content: 'list' }));
		const types = chunks.map((chunk) => chunk.type);
		expect(types).toContain('tool-input-available');
		expect(types).toContain('tool-output-available');
		expect(types).not.toContain('data-permission');
		const saved = await expectOk<ConversationResult>(await request('GET', path));
		const assistant = saved.conversation.messages.at(-1)!;
		expect(assistant.parts.map((part) => part.type)).toEqual(['dynamic-tool', 'text']);
		const tool = assistant.parts[0];
		expect(tool).toMatchObject({ toolName: 'list_catalog', state: 'output-available' });
		expect(typeof (tool as { output?: unknown }).output).toBe('string');
		// The model got the structured result; the second request carries the tool reply.
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('"projects"');
		expect(saved.conversation.continuation).toBeUndefined();
	});

	it('asks for consent before mutating tools and runs them once allowed', async () => {
		const { request, model } = await fixture([
			toolCallStream('create_notebook', { title: 'Revenue', code: 'import marimo as mo' }),
			textStream('Created the notebook.'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const streaming = request('POST', `${path}/stream`, { content: 'make a notebook' });
		const cid = path.split('/').at(-1)!;
		// Wait for the card to be persisted, then answer from a "different" client.
		const card = openCard(await waitForRecord(request, path, (c) => Boolean(openCard(c))));
		expect(card).toMatchObject({ status: 'open', action: 'Create a notebook', can_remember: true });
		expect(card!.details).toContainEqual({ label: 'Title', value: 'Revenue' });
		expect(card!.details).toContainEqual({ label: 'Code', value: 'import marimo as mo' });
		expect(
			await expectOk(
				await request('POST', `${path}/permissions/${card!.id}`, { decision: 'allow' }),
			),
		).toEqual({ accepted: true });
		const chunks = await readChunks(await streaming);
		expect(permissionChunks(chunks).map((permission) => permission.status)).toEqual([
			'open',
			'allowed',
		]);
		expect(chunks.some((chunk) => chunk.type === 'data-working-notebook')).toBe(true);
		const saved = await expectOk<ConversationResult>(await request('GET', path));
		expect(saved.conversation.working_notebook).toBeDefined();
		expect(saved.conversation.messages.at(-1)?.parts.map((part) => part.type)).toEqual([
			'dynamic-tool',
			'data-permission',
			'text',
		]);
		const notebooks = await expectOk<{ items: { title: string }[] }>(
			await request('GET', `/projects/${pid}/notebooks`),
		);
		expect(notebooks.items.map((item) => item.title)).toContain('Revenue');
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('notebook_id');
		expect(
			await expectOk(
				await request('POST', `${path}/permissions/${card!.id}`, { decision: 'deny' }),
			),
		).toEqual({ accepted: false, reason: 'closed' });
		expect(cid).toBe(saved.conversation.id);
	});

	it('leaves a stopped consent wait resumable without an uncertainty review', async () => {
		const { request } = await fixture([
			toolCallStream('create_notebook', { title: 'Later', code: 'import marimo' }),
			textStream('Resumed after the stop.'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const streaming = request('POST', `${path}/stream`, { content: 'make it' });
		await waitForRecord(request, path, (c) => Boolean(openCard(c)));
		await expectOk(await request('POST', `${path}/stop`));
		const chunks = await readChunks(await streaming);
		expect(permissionChunks(chunks).at(-1)?.status).toBe('cancelled');
		const stopped = await expectOk<ConversationResult>(await request('GET', path));
		// The call never ran, so nothing is uncertain: a plain pause, no acknowledgement needed.
		expect(stopped.conversation.continuation).toMatchObject({
			status: 'paused',
			reason: 'stopped',
			unresolved_calls: [],
		});
		const resumed = await expectOk<ConversationResult>(await request('POST', `${path}/resume`, {}));
		expect(messageText(resumed.conversation.messages.at(-1)!)).toBe('Resumed after the stop.');
	});

	it('remembers "always" grants and lets the user revoke them', async () => {
		const { request } = await fixture([
			toolCallStream('create_notebook', { title: 'One', code: 'import marimo' }),
			textStream('Done one.'),
			toolCallStream('create_notebook', { title: 'Two', code: 'import marimo' }),
			textStream('Done two.'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const first = request('POST', `${path}/stream`, { content: 'one' });
		const rid = openCard(await waitForRecord(request, path, (c) => Boolean(openCard(c))))!.id;
		await expectOk(await request('POST', `${path}/permissions/${rid}`, { decision: 'always' }));
		expect(permissionChunks(await readChunks(await first)).at(-1)?.status).toBe('remembered');
		const grants = await expectOk<{ grants: { id: string; scope_key: string }[] }>(
			await request('GET', `/projects/${pid}/chat-permissions`),
		);
		expect(grants.grants.map((grant) => grant.scope_key)).toEqual(['tool:create_notebook']);
		const second = await readChunks(await request('POST', `${path}/stream`, { content: 'two' }));
		expect(permissionChunks(second).map((permission) => permission.status)).toEqual(['remembered']);
		expect(
			await expectOk(
				await request('DELETE', `/projects/${pid}/chat-permissions/${grants.grants[0].id}`),
			),
		).toEqual({ removed: true });
		expect(
			(
				await expectOk<{ grants: unknown[] }>(
					await request('GET', `/projects/${pid}/chat-permissions`),
				)
			).grants,
		).toEqual([]);
	});

	it('skips consent-gated tools on non-interactive sends and tells the model', async () => {
		const { request, model } = await fixture([
			toolCallStream('create_notebook', { title: 'Nope', code: 'import marimo' }),
			textStream('I could not create it.'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const result = await expectOk<ConversationResult>(
			await request('POST', `${path}/messages`, { content: 'make it' }),
		);
		const parts = result.conversation.messages.at(-1)!.parts;
		expect(parts.find((part) => part.type === 'data-permission')).toMatchObject({
			data: { status: 'unavailable' },
		});
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('cannot ask for permission');
		const notebooks = await expectOk<{ items: unknown[] }>(
			await request('GET', `/projects/${pid}/notebooks`),
		);
		expect(notebooks.items).toEqual([]);
	});

	it('records a denied call and continues the turn', async () => {
		const { request } = await fixture([
			toolCallStream('create_notebook', { title: 'Nope', code: 'import marimo' }),
			textStream('Understood, not creating it.'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const streaming = request('POST', `${path}/stream`, { content: 'make it' });
		const rid = openCard(await waitForRecord(request, path, (c) => Boolean(openCard(c))))!.id;
		await expectOk(await request('POST', `${path}/permissions/${rid}`, { decision: 'deny' }));
		const chunks = await readChunks(await streaming);
		expect(permissionChunks(chunks).at(-1)?.status).toBe('denied');
		const output = chunks.find((chunk) => chunk.type === 'tool-output-available');
		expect(String(output?.output)).toContain('denied');
		const saved = await expectOk<ConversationResult>(await request('GET', path));
		expect(messageText(saved.conversation.messages.at(-1)!)).toBe('Understood, not creating it.');
		expect(saved.conversation.continuation).toBeUndefined();
	});

	it('stops a running reply, keeps its partial text, and resumes the task', async () => {
		const cancelled = vi.fn();
		const { request, model } = await fixture([hangingStream(cancelled), textStream('Resumed.')]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const streaming = request('POST', `${path}/stream`, { content: 'long task' });
		await waitForRecord(
			request,
			path,
			(c) => Boolean(c.pending) && messageText(c.messages.at(-1)!) === 'Working',
		);
		expect(await expectOk(await request('POST', `${path}/stop`))).toEqual({ stopped: true });
		const chunks = await readChunks(await streaming);
		expect(chunks.at(-1)).toEqual({ type: 'error', errorText: 'The response was stopped.' });
		const stopped = await expectOk<ConversationResult>(await request('GET', path));
		expect(stopped.conversation.pending).toBeUndefined();
		expect(stopped.conversation.last_error).toBeUndefined();
		expect(stopped.conversation.continuation).toMatchObject({
			status: 'paused',
			reason: 'stopped',
		});
		expect(messageText(stopped.conversation.messages.at(-1)!)).toBe('Working');
		expect(await expectOk(await request('POST', `${path}/stop`))).toEqual({ stopped: false });
		const resumed = await expectOk<ConversationResult>(await request('POST', `${path}/resume`, {}));
		expect(resumed.conversation.continuation).toBeUndefined();
		expect(messageText(resumed.conversation.messages.at(-1)!)).toBe('Resumed.');
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
			'Continue this original request: long task',
		);
		expect(cancelled).toHaveBeenCalled();
	});

	it('re-attaches a reconnecting client to the running reply', async () => {
		const { request } = await fixture([hangingStream(), textStream('x')]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		expect((await request('GET', `${path}/stream`)).status).toBe(204);
		const streaming = request('POST', `${path}/stream`, { content: 'long task' });
		await waitForRecord(request, path, (c) => Boolean(c.pending));
		const reconnect = request('GET', `${path}/stream`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expectOk(await request('POST', `${path}/stop`));
		const replay = await readChunks(await reconnect);
		expect(replay.map((chunk) => chunk.type).slice(0, 3)).toEqual([
			'start',
			'message-metadata',
			'start-step',
		]);
		expect(replay.some((chunk) => chunk.type === 'text-delta' && chunk.delta === 'Working')).toBe(
			true,
		);
		expect(replay.at(-1)?.type).toBe('finish');
		await readChunks(await streaming);
	});

	it('masks provider failures, releases the claim, and lets the user retry', async () => {
		const { request } = await fixture([
			{
				stream: simulateReadableStream<LanguageModelV3StreamPart>({
					chunks: [{ type: 'error', error: new Error('secret-provider-key') }],
				}),
			},
			textStream('Recovered'),
		]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const failure = await expectError(
			await request('POST', `${path}/messages`, { content: 'hello' }),
			503,
		);
		expect(JSON.stringify(failure)).not.toContain('secret-provider-key');
		const failed = await expectOk<ConversationResult>(await request('GET', path));
		expect(failed.conversation.pending).toBeUndefined();
		expect(failed.conversation.last_error).toBeDefined();
		expect(failed.conversation.messages.map(messageText)).toEqual(['hello']);
		const result = await expectOk<ConversationResult>(
			await request('POST', `${path}/messages`, { content: 'retry' }),
		);
		expect(messageText(result.conversation.messages.at(-1)!)).toBe('Recovered');
		expect(result.conversation.last_error).toBeUndefined();
	});

	it('aborts the turn when a blocking client disconnects', async () => {
		const cancelled = vi.fn();
		const { request, app } = await fixture([hangingStream(cancelled)]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		const controller = new AbortController();
		const pending = app.request(`/api/v1${path}/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'hello' }),
			signal: controller.signal,
		});
		await waitForRecord(request, path, (c) => Boolean(c.pending));
		controller.abort();
		await expectError(await pending, 503);
		const saved = await expectOk<ConversationResult>(await request('GET', path));
		expect(saved.conversation.pending).toBeUndefined();
		expect(saved.conversation.continuation).toMatchObject({
			status: 'paused',
			reason: 'interrupted',
		});
	});

	it('manages the notebook pane and dismisses saved tasks', async () => {
		const { request } = await fixture([hangingStream()]);
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		await expectError(
			await request('PATCH', path, { working_notebook: 'nb-0123456789abcdef' }),
			404,
		);
		const notebook = await expectOk<{ id: string }>(
			await request('POST', `/projects/${pid}/notebooks`, {
				title: 'Pane',
				description: 'Pane notebook',
				code: 'import marimo as mo',
			}),
			201,
		);
		const updated = await expectOk<ConversationResult>(
			await request('PATCH', path, { working_notebook: notebook.id }),
		);
		expect(updated.conversation.working_notebook).toBe(notebook.id);
		const cleared = await expectOk<ConversationResult>(
			await request('PATCH', path, { working_notebook: null }),
		);
		expect(cleared.conversation.working_notebook).toBeUndefined();
		const streaming = request('POST', `${path}/stream`, { content: 'task' });
		await waitForRecord(request, path, (c) => Boolean(c.pending));
		await expectError(await request('POST', `${path}/continuation/dismiss`), 409);
		await expectOk(await request('POST', `${path}/stop`));
		await readChunks(await streaming);
		const dismissed = await expectOk<ConversationResult>(
			await request('POST', `${path}/continuation/dismiss`),
		);
		expect(dismissed.conversation.continuation).toBeUndefined();
		await expectOk(await request('DELETE', path));
		await expectError(await request('GET', path), 404);
	});

	it('rejects a turn whose request is malformed', async () => {
		const { request } = await fixture(textStream('x'));
		const pid = await createProject(request);
		const path = await startConversation(request, pid);
		await expectError(await request('POST', `${path}/stream`, { content: '' }), 422);
		await expectError(await request('POST', `${path}/stream`, { resume: true, extra: 1 }), 422);
		await expectError(
			await request('POST', `${path}/permissions/not-a-uuid`, { decision: 'allow' }),
			422,
		);
		await expectError(
			await request('POST', `/projects/${pid}/conversations/not-a-ulid/messages`, { content: 'x' }),
			422,
		);
	});
});
