import { z } from '@hono/zod-openapi';
import { CHAT_LIMITS, PermissionDecisionSchema } from '@marimo-hub/core/chat';
import { NotebookId } from '@marimo-hub/core';

export const CreateConversationBody = z.object({
	title: z.string().trim().min(1).max(120).optional(),
});

export const SendMessageBody = z.object({
	content: z.string().trim().min(1).max(CHAT_LIMITS.messageCharacters),
});

export const ResumeConversationBody = z.strictObject({
	acknowledge_uncertain: z.boolean().optional(),
});

/** One streamed turn: a new message, or a resume of the saved task. */
export const StreamTurnBody = z.union([
	SendMessageBody.extend({ resume: z.literal(false).optional() }),
	z.strictObject({ resume: z.literal(true), acknowledge_uncertain: z.boolean().optional() }),
]);

export const UpdateConversationBody = z.strictObject({
	working_notebook: z
		.string()
		.regex(NotebookId.regex)
		.transform(NotebookId.parse)
		.nullable()
		.openapi({ description: 'Notebook shown beside the conversation; null closes the pane.' }),
});

export const PermissionDecisionBody = z.object({ decision: PermissionDecisionSchema });
