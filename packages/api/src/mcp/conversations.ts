import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConversationIdSchema, messageText, summarizeConversation } from '@marimo-hub/core/chat';
import type { ConversationMessage } from '@marimo-hub/core/chat';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { UnavailableError } from '@marimo-hub/core/errors';
import type { ApiDeps } from '../context';
import {
	assertConversationPrincipal,
	createConversation,
	decidePermission,
	deleteConversation,
	executeTurn,
	getConversation,
	listChatPermissions,
	listConversations,
	revokeChatPermission,
} from '../chat/operations';
import { CreateConversationBody, ResumeConversationBody, SendMessageBody } from '../chat/schemas';
import { failureResult, result, toolError } from './results';
import { resolveProject, PROJECT_REFERENCE_DESCRIPTION } from './selectors';
import type { StartRequestContext } from './server';

const RequestSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('list'),
		limit: z.number().int().min(1).max(50).default(10),
		offset: z.number().int().min(0).max(50).default(0),
	}),
	z.strictObject({
		action: z.literal('get'),
		conversation: ConversationIdSchema,
		message_limit: z.number().int().min(1).max(80).default(10),
		include_tool_details: z.boolean().default(false),
	}),
	z.strictObject({ action: z.literal('create'), ...CreateConversationBody.shape }),
	z.strictObject({
		action: z.literal('send'),
		conversation: ConversationIdSchema,
		...SendMessageBody.shape,
	}),
	z.strictObject({
		action: z.literal('resume'),
		conversation: ConversationIdSchema,
		...ResumeConversationBody.shape,
	}),
	z.strictObject({ action: z.literal('delete'), conversation: ConversationIdSchema }),
	z.strictObject({
		action: z.literal('permissions'),
		limit: z.number().int().min(1).max(200).default(20),
	}),
	z.strictObject({ action: z.literal('revoke_permission'), grant_id: z.uuid() }),
	z.strictObject({
		action: z.literal('decide_permission'),
		conversation: ConversationIdSchema,
		request_id: z.uuid(),
		decision: z.enum(['allow', 'always', 'deny']),
	}),
]);

/** Compact message view for agents: text plus tool names, previews on request. */
function compactMessage(message: ConversationMessage, includeToolDetails: boolean) {
	return {
		id: message.id,
		role: message.role,
		created_at: message.metadata.created_at,
		text: messageText(message),
		tool_calls: message.parts
			.filter((part) => part.type === 'dynamic-tool')
			.map((part) => ({
				tool: part.toolName,
				state: part.state,
				...(includeToolDetails
					? { input: part.input, output: part.output, error: part.errorText }
					: {}),
			})),
	};
}

export function registerConversationTools(
	server: McpServer,
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
): void {
	const name = 'project_conversations';
	server.registerTool(
		name,
		{
			description:
				'Manage your private project chat conversations: list, read, create, send a message, continue an interrupted task, delete, and review or revoke remembered tool permissions. Sending can change project resources through consented tools.',
			inputSchema: z.strictObject({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				request: RequestSchema,
			}),
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async ({ project, request: action }, extra) => {
			const signal = request.signal
				? AbortSignal.any([request.signal, extra.signal])
				: extra.signal;
			try {
				assertConversationPrincipal(principal);
				signal.throwIfAborted();
				const selected = await resolveProject(deps, principal, project);
				const context = {
					deps,
					principal,
					pid: selected.id,
					signal,
					appBaseUrl: request.appBaseUrl,
				};
				switch (action.action) {
					case 'list': {
						const { conversations } = await listConversations(context);
						return result({
							conversations: conversations.slice(action.offset, action.offset + action.limit),
							total_conversations: conversations.length,
							has_more: action.offset + action.limit < conversations.length,
						});
					}
					case 'get': {
						const { conversation } = await getConversation({
							...context,
							cid: action.conversation,
						});
						const messages = conversation.messages.slice(-action.message_limit);
						return result({
							conversation: summarizeConversation(conversation),
							messages: messages.map((message) =>
								compactMessage(message, action.include_tool_details),
							),
							has_earlier: messages.length < conversation.messages.length,
							continuation: conversation.continuation,
						});
					}
					case 'create': {
						const { conversation } = await createConversation({
							...context,
							title: action.title,
						});
						return result({ conversation: summarizeConversation(conversation) });
					}
					case 'send':
					case 'resume': {
						const { conversation } = await executeTurn({
							...context,
							cid: action.conversation,
							...(action.action === 'resume'
								? { resume: true, acknowledgeUncertain: action.acknowledge_uncertain }
								: { content: action.content }),
						});
						const message = conversation.messages.at(-1);
						if (message?.role !== 'assistant')
							throw new UnavailableError('The assistant response was not saved');
						return result({
							conversation: summarizeConversation(conversation),
							message: compactMessage(message, false),
							continuation: conversation.continuation,
						});
					}
					case 'delete':
						return result(await deleteConversation({ ...context, cid: action.conversation }));
					case 'permissions': {
						const { grants } = await listChatPermissions(context);
						return result({
							grants: grants.slice(0, action.limit),
							has_more: grants.length > action.limit,
						});
					}
					case 'revoke_permission':
						return result(await revokeChatPermission({ ...context, grant_id: action.grant_id }));
					case 'decide_permission':
						return result(
							await decidePermission({
								...context,
								cid: action.conversation,
								rid: action.request_id,
								decision: action.decision,
							}),
						);
				}
			} catch (error) {
				if (signal.aborted)
					return failureResult({
						code: 'REQUEST_CANCELLED',
						message: 'The conversation request was cancelled.',
					});
				return toolError(error, { ...request, signal, userId: principal.id, tool: name });
			}
		},
	);
}
