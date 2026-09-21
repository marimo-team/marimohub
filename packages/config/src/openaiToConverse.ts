// Claude on Bedrock requires Converse; marimo clients speak OpenAI Chat Completions.
import type {
	AssistantModelMessage,
	FinishReason,
	LanguageModel,
	LanguageModelUsage,
	UserModelMessage,
} from 'ai';
import { generateText, streamText } from 'ai';

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

// The marimo chat/edit path uses text only; tool turns have no Converse representation here.
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
				// A tool-call-only assistant turn (content: null) has no usable text;
				// pushing an empty turn can make Bedrock reject the request.
				if (text !== '') conversation.push({ role: 'assistant', content: text });
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
	const maxOutputTokens = resolveMaxOutputTokens(request, options);
	return {
		model: options.model,
		messages: conversation,
		abortSignal: options.signal,
		...(system !== undefined ? { instructions: system } : {}),
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
		...(request.top_p !== undefined ? { topP: request.top_p } : {}),
		...(request.stop !== undefined ? { stopSequences: normalizeStop(request.stop) } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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

/** OpenAI-shaped error body so marimo's `openai` client surfaces a clean message. */
function openAiErrorBody(message: string, type: string) {
	return { error: { message, type } };
}

// Provider failures must end with an error, not a success finish or [DONE].
function streamingResponse(request: OpenAiChatRequest, options: ConverseBridgeOptions): Response {
	const created = Math.floor((options.now?.() ?? Date.now()) / 1000);
	const id = chatCompletionId(options.now?.() ?? Date.now());
	const base = { id, object: 'chat.completion.chunk', created, model: options.modelId };

	const cancelled = new AbortController();
	const signal = AbortSignal.any([options.signal, cancelled.signal]);
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let finishReason: FinishReason = 'stop';
			let usage: LanguageModelUsage | undefined;
			let streamError: unknown;
			try {
				const result = streamText(callSettings(request, { ...options, signal }));
				controller.enqueue(
					sseChunk({
						...base,
						choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
					}),
				);
				for await (const part of result.stream) {
					if (cancelled.signal.aborted) return;
					if (part.type === 'text-delta') {
						controller.enqueue(
							sseChunk({
								...base,
								choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
							}),
						);
					} else if (part.type === 'finish') {
						finishReason = part.finishReason;
						usage = part.totalUsage;
					} else if (part.type === 'error') {
						streamError = part.error;
						break;
					} else if (part.type === 'abort') {
						streamError = new Error(part.reason ?? 'stream aborted');
						break;
					}
				}
			} catch (error) {
				streamError = error;
			}
			if (cancelled.signal.aborted) return;
			if (streamError !== undefined) {
				controller.enqueue(
					sseChunk(openAiErrorBody('Upstream AI provider unreachable', 'api_error')),
				);
				options.onStreamError?.(streamError);
			} else {
				controller.enqueue(
					sseChunk({
						...base,
						choices: [{ index: 0, delta: {}, finish_reason: toOpenAiFinishReason(finishReason) }],
						...(usage !== undefined ? { usage: toOpenAiUsage(usage) } : {}),
					}),
				);
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			}
			controller.close();
		},
		cancel(reason) {
			cancelled.abort(reason);
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

function numberField(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

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
