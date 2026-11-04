import { z } from 'zod';
import { NotebookId } from '../../ids';

/** Hard ceilings shared by the service, the API turn runner, and the UI. */
export const CHAT_LIMITS = {
	/** User message length. */
	messageCharacters: 8000,
	/** Visible assistant text per message. */
	answerCharacters: 24000,
	/** Total visible text per conversation before sends are refused. */
	conversationCharacters: 96000,
	/** Messages per conversation before sends are refused; the schema allows one more turn. */
	messagesPerConversation: 78,
	/** Tool calls per assistant turn. One number so the model, tools, and storage agree. */
	toolCallsPerTurn: 24,
	/** Conversations per person per project. */
	conversationsPerProject: 50,
	/** Redacted tool input/output preview length. */
	previewCharacters: 2000,
	/** One field on a consent card, enough to read the code being approved. */
	consentDetailCharacters: 20_000,
} as const;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Provider tool-call ids; checkpoint ids prefix them with a ULID claim id and a colon. */
const TOOL_CALL_ID_CHARACTERS = 128;
const CHECKPOINT_ID_CHARACTERS = 26 + 1 + TOOL_CALL_ID_CHARACTERS;

export const ConversationIdSchema = z.string().regex(ULID);

export const PermissionStatusSchema = z.enum([
	'open',
	'allowed',
	'remembered',
	'denied',
	'expired',
	'cancelled',
	'unavailable',
]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

/** One consent request for a gated tool call, stored as a `data-permission` part. */
export const ConversationPermissionSchema = z.object({
	id: z.uuid(),
	tool_call_id: z.string().max(TOOL_CALL_ID_CHARACTERS),
	kind: z.string().max(40),
	action: z.string().max(120),
	details: z
		.array(
			z.object({
				label: z.string().max(40),
				value: z.string().max(CHAT_LIMITS.consentDetailCharacters),
			}),
		)
		.max(6),
	scope: z.object({ key: z.string().max(200), label: z.string().max(120) }),
	/** Whether "always allow" is offered; destructive actions ask every time. */
	can_remember: z.boolean(),
	status: PermissionStatusSchema,
	expires_at: z.iso.datetime(),
});
export type ConversationPermission = z.infer<typeof ConversationPermissionSchema>;

export const PermissionDecisionSchema = z.enum(['allow', 'always', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

// Parts mirror the AI SDK UI message parts so the client renders stored and
// streamed messages through one code path. Tool input and output hold redacted
// string previews, never the raw payloads the model exchanged.
export const ConversationTextPartSchema = z.object({
	type: z.literal('text'),
	text: z.string().max(CHAT_LIMITS.answerCharacters),
	state: z.enum(['streaming', 'done']).optional(),
});
export type ConversationTextPart = z.infer<typeof ConversationTextPartSchema>;

export const ConversationToolPartSchema = z.object({
	type: z.literal('dynamic-tool'),
	toolName: z.string().max(80),
	toolCallId: z.string().max(TOOL_CALL_ID_CHARACTERS),
	state: z.enum(['input-streaming', 'input-available', 'output-available', 'output-error']),
	input: z.string().max(CHAT_LIMITS.previewCharacters).optional(),
	output: z.string().max(CHAT_LIMITS.previewCharacters).optional(),
	errorText: z.string().max(CHAT_LIMITS.previewCharacters).optional(),
});
export type ConversationToolPart = z.infer<typeof ConversationToolPartSchema>;

export const ConversationPermissionPartSchema = z.object({
	type: z.literal('data-permission'),
	id: z.uuid(),
	data: ConversationPermissionSchema,
});
export type ConversationPermissionPart = z.infer<typeof ConversationPermissionPartSchema>;

export const ConversationMessagePartSchema = z.discriminatedUnion('type', [
	ConversationTextPartSchema,
	ConversationToolPartSchema,
	ConversationPermissionPartSchema,
]);
export type ConversationMessagePart = z.infer<typeof ConversationMessagePartSchema>;

export const ConversationMessageMetadataSchema = z.object({
	created_at: z.iso.datetime(),
});
export type ConversationMessageMetadata = z.infer<typeof ConversationMessageMetadataSchema>;

export const ConversationMessageSchema = z.object({
	id: z.string().min(1).max(80),
	role: z.enum(['user', 'assistant']),
	metadata: ConversationMessageMetadataSchema,
	parts: z.array(ConversationMessagePartSchema).max(80),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export function messageText(message: Pick<ConversationMessage, 'parts'>): string {
	return message.parts
		.filter((part): part is ConversationTextPart => part.type === 'text')
		.map((part) => part.text)
		.join('');
}
export function messageToolParts(message: Pick<ConversationMessage, 'parts'>) {
	return message.parts.filter((part): part is ConversationToolPart => part.type === 'dynamic-tool');
}
export function conversationTextLength(messages: readonly Pick<ConversationMessage, 'parts'>[]) {
	return messages.reduce((total, message) => total + messageText(message).length, 0);
}

export const ConversationObservationSchema = z.object({
	id: z.string().min(1).max(CHECKPOINT_ID_CHARACTERS),
	name: z.string().min(1).max(128),
	result: z.string().max(4000),
});
export type ConversationObservation = z.infer<typeof ConversationObservationSchema>;

/**
 * The saved task behind an assistant turn. It lets a paused, stopped, or
 * interrupted turn resume with the tool results it already recorded instead of
 * repeating them.
 */
export const ConversationContinuationSchema = z.object({
	status: z.enum(['running', 'paused', 'needs_review']),
	reason: z.enum(['tool_limit', 'context_limit', 'interrupted', 'stopped', 'failed']).optional(),
	task: z.string().max(CHAT_LIMITS.messageCharacters),
	omitted_observations: z.number().int().nonnegative().optional(),
	observations: z
		.array(ConversationObservationSchema)
		.max(16)
		.refine((items) => items.reduce((total, item) => total + item.result.length, 0) <= 32000),
	/** Mutating tool calls that started without a saved outcome. */
	unresolved_calls: z
		.array(z.object({ id: z.string().max(CHECKPOINT_ID_CHARACTERS), name: z.string().max(128) }))
		.max(CHAT_LIMITS.toolCallsPerTurn),
});
export type ConversationContinuation = z.infer<typeof ConversationContinuationSchema>;

export const ConversationPendingSchema = z.object({
	id: ConversationIdSchema,
	expires_at: z.iso.datetime(),
	/** Set by `requestStop`; the turn owner polls it so stops work from any replica. */
	stop_requested: z.boolean().optional(),
});

export const ConversationSchema = z.object({
	schema_version: z.literal(1),
	id: ConversationIdSchema,
	title: z.string().max(120),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
	messages: z
		.array(ConversationMessageSchema)
		.max(CHAT_LIMITS.messagesPerConversation + 2)
		.refine(
			(messages) => conversationTextLength(messages) <= CHAT_LIMITS.conversationCharacters,
			'Conversation text exceeds the limit',
		),
	pending: ConversationPendingSchema.optional(),
	last_error: z.string().max(400).optional(),
	continuation: ConversationContinuationSchema.optional(),
	/** The notebook shown beside this conversation, when one is open. */
	working_notebook: z.string().regex(NotebookId.regex).transform(NotebookId.parse).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationSummarySchema = ConversationSchema.omit({
	messages: true,
	continuation: true,
}).extend({
	message_count: z.number().int().nonnegative(),
	continuation: ConversationContinuationSchema.pick({ status: true, reason: true }).optional(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export function summarizeConversation(conversation: Conversation): ConversationSummary {
	const { messages, continuation, ...rest } = conversation;
	return ConversationSummarySchema.parse({
		...rest,
		message_count: messages.length,
		...(continuation
			? { continuation: { status: continuation.status, reason: continuation.reason } }
			: {}),
	});
}

export const StoredConversationSchema = ConversationSchema.extend({
	/** Consent decisions for the active turn only; cleared on claim and on finish. */
	permission_decisions: z
		.array(
			z.object({
				turn_id: ConversationIdSchema,
				request_id: z.uuid(),
				decision: PermissionDecisionSchema,
			}),
		)
		.max(CHAT_LIMITS.toolCallsPerTurn)
		.optional(),
	/** Soft-delete fence written before the index and subordinate objects are cleaned up. */
	deleted_at: z.iso.datetime().optional(),
});
export type StoredConversation = z.infer<typeof StoredConversationSchema>;

export const ConversationIndexSchema = z.object({
	schema_version: z.literal(1),
	ids: z.array(ConversationIdSchema).max(CHAT_LIMITS.conversationsPerProject),
});
export type ConversationIndex = z.infer<typeof ConversationIndexSchema>;
