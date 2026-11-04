import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { DEFAULT_CHAT_CONFIG } from '../context';
import type { ApiDeps } from '../context';

// Scripted language-model responses for chat tests. Each helper is one
// `doStream` result; pass several to `chatModel` to script a multi-step turn.

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export function finish(unified: 'stop' | 'tool-calls' | 'length'): LanguageModelV3StreamPart {
	return { type: 'finish', finishReason: { unified, raw: unified }, usage: USAGE };
}

export function textStream(text: string): LanguageModelV3StreamResult {
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

export function toolCallStream(
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

/** Emits a first word and then never ends, until the SDK cancels it. */
export function hangingStream(onCancel?: () => void): LanguageModelV3StreamResult {
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

export function chatModel(...responses: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		modelId: 'configured-model',
		doStream: responses.length === 1 ? responses[0] : responses,
	});
}

/** Managed-AI deps with chat on, backed by the given model. */
export function chatAi(
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
