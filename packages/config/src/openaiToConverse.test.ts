import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { converseChatCompletion } from './openaiToConverse';

const usage = {
	inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function streamingModel(deltas: string[], result: 'stop' | 'length' | Error = 'stop') {
	const parts: LanguageModelV4StreamPart[] = [
		{ type: 'stream-start', warnings: [] },
		{ type: 'text-start', id: '0' },
		...deltas.map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: '0', delta })),
	];
	if (result instanceof Error) {
		parts.push({ type: 'error', error: result });
	} else {
		parts.push(
			{ type: 'text-end', id: '0' },
			{ type: 'finish', finishReason: { unified: result, raw: result }, usage },
		);
	}
	return new MockLanguageModelV4({
		doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
	});
}

function generatingModel(text: string, unified: 'stop' | 'length' = 'stop') {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: 'text', text }],
			finishReason: { unified, raw: unified },
			usage,
			warnings: [],
		}),
	});
}

async function readSse(
	res: Response,
): Promise<{ done: boolean; chunks: Record<string, unknown>[] }> {
	const body = await res.text();
	const datas = body
		.split('\n\n')
		.map((block) => block.replace(/^data: /, '').trim())
		.filter(Boolean);
	const done = datas.at(-1) === '[DONE]';
	const chunks = datas
		.filter((d) => d !== '[DONE]')
		.map((d) => JSON.parse(d) as Record<string, unknown>);
	return { done, chunks };
}

type Choice = {
	index: number;
	delta?: { role?: string; content?: string };
	finish_reason: string | null;
};

describe('converseChatCompletion — streaming', () => {
	it('re-encodes the model stream as OpenAI chat.completion.chunk SSE', async () => {
		const res = converseChatCompletion({
			model: streamingModel(['Hel', 'lo', ' world']),
			modelId: 'eu.anthropic.claude-opus-4-7',
			payload: {
				model: 'eu.anthropic.claude-opus-4-7',
				stream: true,
				messages: [
					{ role: 'system', content: 'be terse' },
					{ role: 'user', content: 'hi' },
				],
			},
			signal: new AbortController().signal,
		}) as Response;

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

		const { done, chunks } = await readSse(res);
		expect(done).toBe(true);

		for (const chunk of chunks) {
			expect(chunk.object).toBe('chat.completion.chunk');
			expect(chunk.model).toBe('eu.anthropic.claude-opus-4-7');
		}

		const choices = chunks.map((c) => (c.choices as Choice[])[0]);
		expect(choices[0].delta).toEqual({ role: 'assistant' });
		const text = choices.map((c) => c.delta?.content ?? '').join('');
		expect(text).toBe('Hello world');
		const last = chunks.at(-1) as { choices: Choice[]; usage: unknown };
		expect(last.choices[0].finish_reason).toBe('stop');
		expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
	});

	it('maps a length finish to the OpenAI enum', async () => {
		const res = converseChatCompletion({
			model: streamingModel(['x'], 'length'),
			modelId: 'anthropic.claude-3-5-sonnet',
			payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
			signal: new AbortController().signal,
		}) as Response;
		const { chunks } = await readSse(res);
		const last = chunks.at(-1) as { choices: Choice[] };
		expect(last.choices[0].finish_reason).toBe('length');
	});

	it('aborts provider generation when the response body is cancelled', async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const onStreamError = vi.fn();
		const model = new MockLanguageModelV4({
			doStream: async ({ abortSignal }) => {
				started.resolve(abortSignal!);
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							controller.enqueue({ type: 'stream-start', warnings: [] });
							abortSignal!.addEventListener('abort', () => controller.close(), { once: true });
						},
					}),
				};
			},
		});
		const res = await converseChatCompletion({
			model,
			modelId: 'anthropic.claude-3-5-sonnet',
			payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
			signal: new AbortController().signal,
			onStreamError,
		});
		const signal = await started.promise;
		await res.body!.cancel('client disconnected');
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBe('client disconnected');
		expect(onStreamError).not.toHaveBeenCalled();
	});

	it('encodes a synchronous SDK setup failure as an error event', async () => {
		const onStreamError = vi.fn();
		const res = await converseChatCompletion({
			model: streamingModel(['unused']),
			modelId: 'anthropic.claude-3-5-sonnet',
			payload: { stream: true, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] },
			signal: new AbortController().signal,
			onStreamError,
		});
		const { done, chunks } = await readSse(res);
		expect(done).toBe(false);
		expect(chunks).toEqual([
			{ error: { message: 'Upstream AI provider unreachable', type: 'api_error' } },
		]);
		expect(onStreamError).toHaveBeenCalledOnce();
	});

	it('signals a mid-stream failure instead of a clean stop', async () => {
		const onStreamError = vi.fn();
		const res = converseChatCompletion({
			model: streamingModel(['par', 'tial'], new Error('bedrock exploded')),
			modelId: 'anthropic.claude-3-5-sonnet',
			payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
			signal: new AbortController().signal,
			onStreamError,
		}) as Response;

		const body = await res.text();
		expect(body).toContain('"content":"par"');
		expect(body).toContain('"error"');
		expect(body).not.toContain('"finish_reason":"stop"');
		expect(body).not.toContain('[DONE]');
		expect(onStreamError).toHaveBeenCalledOnce();
	});
});

describe('converseChatCompletion — non-streaming', () => {
	it('returns a single OpenAI chat.completion JSON body', async () => {
		const res = await converseChatCompletion({
			model: generatingModel('SELECT 1'),
			modelId: 'eu.anthropic.claude-opus-4-7',
			payload: {
				model: 'eu.anthropic.claude-opus-4-7',
				messages: [{ role: 'user', content: 'hi' }],
			},
			signal: new AbortController().signal,
		});

		expect(res.headers.get('content-type')).toContain('application/json');
		const body = (await res.json()) as {
			object: string;
			model: string;
			choices: { message: { role: string; content: string }; finish_reason: string }[];
			usage: Record<string, number>;
		};
		expect(body.object).toBe('chat.completion');
		expect(body.model).toBe('eu.anthropic.claude-opus-4-7');
		expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'SELECT 1' });
		expect(body.choices[0].finish_reason).toBe('stop');
		expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
	});

	it('drops a tool-call-only assistant turn instead of sending empty content', async () => {
		const model = generatingModel('ok');
		await converseChatCompletion({
			model,
			modelId: 'anthropic.claude-3-5-sonnet',
			payload: {
				messages: [
					{ role: 'user', content: 'run a tool' },
					{
						role: 'assistant',
						content: null,
						tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
					},
					{ role: 'user', content: 'continue' },
				],
			},
			signal: new AbortController().signal,
		});

		// The empty assistant turn must not reach the model (Bedrock rejects it).
		const prompt = model.doGenerateCalls[0].prompt;
		expect(prompt.some((m) => m.role === 'assistant')).toBe(false);
		expect(prompt.filter((m) => m.role === 'user')).toHaveLength(2);
	});

	it('propagates a pre-stream model failure as a rejection', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error('bedrock unreachable');
			},
		});
		await expect(
			converseChatCompletion({
				model,
				modelId: 'anthropic.claude-3-5-sonnet',
				payload: { messages: [{ role: 'user', content: 'hi' }] },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('bedrock unreachable');
	});
});

describe('converseChatCompletion — request conversion', () => {
	it.each([false, true])(
		'preserves messages and generation settings with stream=%s',
		async (stream) => {
			const model = stream ? streamingModel(['ok']) : generatingModel('ok');
			const res = await converseChatCompletion({
				model,
				modelId: 'anthropic.claude-3-5-sonnet',
				payload: {
					stream,
					messages: [
						{ role: 'system', content: 'Be concise.' },
						{ role: 'developer', content: [{ type: 'text', text: 'Use SQL.' }] },
						{
							role: 'user',
							content: [
								{ type: 'text', text: 'Hello' },
								{ type: 'text', text: ' world' },
							],
						},
						{ role: 'assistant', content: 'Hi' },
						{ role: 'user', content: 'Continue' },
					],
					temperature: 0.3,
					top_p: 0.9,
					stop: 'END',
					max_tokens: 20,
					max_completion_tokens: 10,
				},
				maxOutputTokens: 50,
				signal: new AbortController().signal,
			});
			await res.text();
			const call = stream ? model.doStreamCalls[0] : model.doGenerateCalls[0];
			expect(call).toMatchObject({
				temperature: 0.3,
				topP: 0.9,
				stopSequences: ['END'],
				maxOutputTokens: 10,
			});
			expect(call.prompt).toEqual([
				{ role: 'system', content: 'Be concise.\n\nUse SQL.' },
				{ role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
				{ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
				{ role: 'user', content: [{ type: 'text', text: 'Continue' }] },
			]);
		},
	);

	it.each([
		{ payload: {}, expected: 50 },
		{ payload: { max_tokens: 20 }, expected: 20 },
		{ payload: { max_completion_tokens: 10 }, expected: 10 },
		{ payload: { max_tokens: 'invalid' }, expected: 50 },
	])('resolves the output token limit from $payload', async ({ payload, expected }) => {
		const model = generatingModel('ok');
		await converseChatCompletion({
			model,
			modelId: 'anthropic.claude-3-5-sonnet',
			payload: { messages: [{ role: 'user', content: 'hi' }], ...payload },
			maxOutputTokens: 50,
			signal: new AbortController().signal,
		});
		expect(model.doGenerateCalls[0].maxOutputTokens).toBe(expected);
	});
});
