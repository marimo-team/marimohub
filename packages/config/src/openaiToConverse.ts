/**
 * Translate an OpenAI Chat Completions request into an AI-SDK call and re-encode
 * the result as OpenAI wire format. Anthropic Claude on Bedrock is reachable only
 * through the Converse API, which the `@ai-sdk/amazon-bedrock` provider speaks;
 * marimo, however, is an OpenAI client that POSTs `/chat/completions` and expects
 * OpenAI ChatCompletion SSE (or JSON) back. This bridge sits between the two so
 * Claude works through the same managed-AI proxy as the GPT passthrough.
 *
 * It is model-agnostic: it takes a resolved AI-SDK `LanguageModel`, so tests can
 * drive it with a mock model without a live Bedrock call.
 */
import type {
	AssistantModelMessage,
	FinishReason,
	LanguageModel,
	LanguageModelUsage,
	UserModelMessage,
} from 'ai';
import { generateText, streamText } from 'ai';

/** Minimal shape of the fields we read from an OpenAI Chat Completions body. */
interface OpenAiChatRequest {
	messages: OpenAiMessage[];
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	stop?: string | string[];
}

interface OpenAiMessage {
	role: string;
	content: unknown;
}

export interface ConverseBridgeOptions {
	model: LanguageModel;
	/** Resolved (allowlisted) model id echoed back in the OpenAI response. */
	modelId: string;
	payload: Record<string, unknown>;
	signal: AbortSignal;
	/** Deployment cap applied when the request omits its own token limit. */
	maxOutputTokens?: number;
	/** Report a mid-stream failure once the 200 response headers are already sent. */
	onStreamError?: (error: unknown) => void;
	now?: () => number;
}

/** Flatten OpenAI message content (string, or an array of parts) to text. */
function contentToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
					? part.text
					: '',
			)
			.join('');
	}
	return '';
}

/**
 * Split OpenAI messages into the AI-SDK `system` instruction (which the SDK
 * requires be passed separately, not as a message) and the user/assistant
 * conversation. `developer` collapses to system; tool-call turns are out of
 * scope for the marimo chat/edit path and are dropped rather than mistranslated.
 */
function partitionMessages(messages: OpenAiMessage[]): {
	system: string | undefined;
	conversation: (UserModelMessage | AssistantModelMessage)[];
} {
	const system: string[] = [];
	const conversation: (UserModelMessage | AssistantModelMessage)[] = [];
	for (const message of messages) {
		const text = contentToText(message.content);
		switch (message.role) {
			case 'system':
			case 'developer':
				system.push(text);
				break;
			case 'assistant':
				conversation.push({ role: 'assistant', content: text });
				break;
			case 'user':
				conversation.push({ role: 'user', content: text });
				break;
			default:
				break;
		}
	}
	return { system: system.length > 0 ? system.join('\n\n') : undefined, conversation };
}

/** OpenAI splits a token cap across two field names; either may carry it. */
function requestedMaxTokens(request: OpenAiChatRequest): number | undefined {
	return request.max_completion_tokens ?? request.max_tokens;
}

/** AI-SDK finish reasons onto the OpenAI `finish_reason` enum. */
const FINISH_REASON: Record<FinishReason, string> = {
	stop: 'stop',
	length: 'length',
	'content-filter': 'content_filter',
	'tool-calls': 'tool_calls',
	error: 'stop',
	other: 'stop',
};

function toOpenAiFinishReason(reason: FinishReason): string {
	return FINISH_REASON[reason] ?? 'stop';
}

interface OpenAiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

function toOpenAiUsage(usage: LanguageModelUsage): OpenAiUsage {
	const prompt = usage.inputTokens ?? 0;
	const completion = usage.outputTokens ?? 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: usage.totalTokens ?? prompt + completion,
	};
}

function chatCompletionId(now: number): string {
	return `chatcmpl-${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function callSettings(request: OpenAiChatRequest, options: ConverseBridgeOptions) {
	const { system, conversation } = partitionMessages(request.messages);
	return {
		model: options.model,
		messages: conversation,
		abortSignal: options.signal,
		...(system !== undefined ? { system } : {}),
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
		...(request.top_p !== undefined ? { topP: request.top_p } : {}),
		...(request.stop !== undefined ? { stopSequences: normalizeStop(request.stop) } : {}),
		...(resolveMaxOutputTokens(request, options) !== undefined
			? { maxOutputTokens: resolveMaxOutputTokens(request, options) }
			: {}),
	};
}

function normalizeStop(stop: string | string[]): string[] {
	return Array.isArray(stop) ? stop : [stop];
}

function resolveMaxOutputTokens(
	request: OpenAiChatRequest,
	options: ConverseBridgeOptions,
): number | undefined {
	return requestedMaxTokens(request) ?? options.maxOutputTokens;
}

const encoder = new TextEncoder();

function sseChunk(data: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Stream an OpenAI `chat.completion.chunk` SSE sequence: a role delta, one delta
 * per text token, a terminal delta carrying `finish_reason` and `usage`, then the
 * `[DONE]` sentinel marimo's client waits for.
 */
function streamingResponse(request: OpenAiChatRequest, options: ConverseBridgeOptions): Response {
	const created = Math.floor((options.now?.() ?? Date.now()) / 1000);
	const id = chatCompletionId(options.now?.() ?? Date.now());
	const base = { id, object: 'chat.completion.chunk', created, model: options.modelId };

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const result = streamText(callSettings(request, options));
			try {
				controller.enqueue(
					sseChunk({
						...base,
						choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
					}),
				);
				for await (const delta of result.textStream) {
					controller.enqueue(
						sseChunk({
							...base,
							choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
						}),
					);
				}
				const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
				controller.enqueue(
					sseChunk({
						...base,
						choices: [{ index: 0, delta: {}, finish_reason: toOpenAiFinishReason(finishReason) }],
						usage: toOpenAiUsage(usage),
					}),
				);
			} catch (error) {
				// The 200 headers are already sent, so we cannot downgrade to an error
				// status: close the SSE cleanly and let the caller log the failure.
				options.onStreamError?.(error);
			} finally {
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

/** Render a single OpenAI `chat.completion` JSON body. */
async function nonStreamingResponse(
	request: OpenAiChatRequest,
	options: ConverseBridgeOptions,
): Promise<Response> {
	const result = await generateText(callSettings(request, options));
	const created = Math.floor((options.now?.() ?? Date.now()) / 1000);
	const body = {
		id: chatCompletionId(options.now?.() ?? Date.now()),
		object: 'chat.completion',
		created,
		model: options.modelId,
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: result.text },
				finish_reason: toOpenAiFinishReason(result.finishReason),
			},
		],
		usage: toOpenAiUsage(result.usage),
	};
	return Response.json(body);
}

/**
 * Bridge one OpenAI Chat Completions request to the Converse-backed model and
 * return an OpenAI-shaped response. Streams when the request set `stream: true`;
 * otherwise returns a single JSON completion. Non-streaming failures reject so
 * the caller can map them to an error status; streaming failures are reported
 * through `onStreamError`.
 */
/** Read a number field, ignoring non-numeric junk from an untrusted body. */
function numberField(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

/** Extract the fields the bridge needs from the untrusted OpenAI request body. */
function parseRequest(payload: Record<string, unknown>): OpenAiChatRequest {
	const rawMessages = payload.messages;
	const messages: OpenAiMessage[] = Array.isArray(rawMessages)
		? rawMessages.filter(
				(m): m is OpenAiMessage => typeof m === 'object' && m !== null && 'role' in m,
			)
		: [];
	const stop = payload.stop;
	return {
		messages,
		stream: payload.stream === true,
		temperature: numberField(payload.temperature),
		top_p: numberField(payload.top_p),
		max_tokens: numberField(payload.max_tokens),
		max_completion_tokens: numberField(payload.max_completion_tokens),
		stop:
			typeof stop === 'string'
				? stop
				: Array.isArray(stop)
					? stop.filter((s): s is string => typeof s === 'string')
					: undefined,
	};
}

export function converseChatCompletion(
	options: ConverseBridgeOptions,
): Response | Promise<Response> {
	const request = parseRequest(options.payload);
	return request.stream
		? streamingResponse(request, options)
		: nonStreamingResponse(request, options);
}
