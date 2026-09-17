import { describe, expect, it } from 'vitest';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { converseChatCompletion } from './openaiToConverse';

/** Nested provider-shape usage the AI SDK flattens to `{ inputTokens, outputTokens, totalTokens }`. */
const usage = {
	inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function streamingModel(deltas: string[], unified: 'stop' | 'length' = 'stop') {
	const parts: LanguageModelV4StreamPart[] = [
		{ type: 'stream-start', warnings: [] },
		{ type: 'text-start', id: '0' },
		...deltas.map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: '0', delta })),
		{ type: 'text-end', id: '0' },
		{ type: 'finish', finishReason: { unified, raw: unified }, usage },
	];
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

/** Parse an OpenAI `text/event-stream` body into its decoded `data:` payloads. */
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

		// Every chunk is a chat.completion.chunk echoing the resolved model id.
		for (const chunk of chunks) {
			expect(chunk.object).toBe('chat.completion.chunk');
			expect(chunk.model).toBe('eu.anthropic.claude-opus-4-7');
		}

		const choices = chunks.map((c) => (c.choices as Choice[])[0]);
		// First chunk opens the assistant turn.
		expect(choices[0].delta).toEqual({ role: 'assistant' });
		// Content deltas reassemble the full text.
		const text = choices.map((c) => c.delta?.content ?? '').join('');
		expect(text).toBe('Hello world');
		// Terminal chunk carries the mapped finish_reason and usage.
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
