import { createRoute, z } from '@hono/zod-openapi';
import { createUIMessageStreamResponse } from 'ai';
import { deferOrAwait } from '@marimo-hub/core';
import {
	ChatPermissionGrantSchema,
	ConversationIdSchema,
	ConversationSchema,
	ConversationSummarySchema,
} from '@marimo-hub/core/chat';
import {
	createConversation,
	decidePermission,
	deleteConversation,
	dismissContinuation,
	executeTurn,
	getConversation,
	listChatPermissions,
	listConversations,
	reconnectTurn,
	revokeChatPermission,
	stopConversation,
	streamTurn,
	updateConversation,
} from '../chat/operations';
import {
	CreateConversationBody,
	PermissionDecisionBody,
	ResumeConversationBody,
	SendMessageBody,
	StreamTurnBody,
	UpdateConversationBody,
} from '../chat/schemas';
import type { HonoEnv } from '../context';
import {
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	ok,
	ProjectIdParam,
	resolvePublicBaseUrl,
} from '../shared';
import type { Context } from 'hono';

const app = createApp();
const TAGS = ['Conversations'];
const Params = ProjectIdParam.extend({ cid: ConversationIdSchema });
const ConversationResponse = z.object({
	success: z.literal(true),
	data: z.object({ conversation: ConversationSchema }),
});
const conversationResponses = {
	200: jsonContent(ConversationResponse, 'Private project conversation'),
	...errorResponses(400, 401, 403, 404, 409, 422, 503),
};

function context(c: Context<HonoEnv>) {
	const deps = c.get('deps');
	return {
		deps,
		principal: c.get('user'),
		signal: c.req.raw.signal,
		appBaseUrl: resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
	};
}

app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/conversations',
		operationId: 'conversations.list',
		tags: TAGS,
		summary: 'List your conversations in a project',
		request: { params: ProjectIdParam },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: z.object({ conversations: z.array(ConversationSummarySchema) }),
				}),
				'Private project conversations, newest first',
			),
			...errorResponses(401, 403, 404),
		},
	}),
	async (c) => ok(c, await listConversations({ ...context(c), ...c.req.valid('param') })),
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations',
		operationId: 'conversations.create',
		tags: TAGS,
		summary: 'Start a private conversation',
		request: { params: ProjectIdParam, body: jsonBody(CreateConversationBody) },
		responses: conversationResponses,
	}),
	async (c) =>
		ok(
			c,
			await createConversation({
				...context(c),
				...c.req.valid('param'),
				...c.req.valid('json'),
			}),
		),
);

app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/conversations/{cid}',
		operationId: 'conversations.get',
		tags: TAGS,
		summary: 'Read a conversation',
		request: { params: Params },
		responses: conversationResponses,
	}),
	async (c) => ok(c, await getConversation({ ...context(c), ...c.req.valid('param') })),
);

app.openapi(
	createRoute({
		method: 'patch',
		path: '/projects/{pid}/conversations/{cid}',
		operationId: 'conversations.update',
		'x-cli-hidden': true,
		tags: TAGS,
		summary: 'Choose the notebook shown beside a conversation',
		request: { params: Params, body: jsonBody(UpdateConversationBody) },
		responses: conversationResponses,
	}),
	async (c) =>
		ok(
			c,
			await updateConversation({
				...context(c),
				...c.req.valid('param'),
				...c.req.valid('json'),
			}),
		),
);

app.openapi(
	createRoute({
		method: 'delete',
		path: '/projects/{pid}/conversations/{cid}',
		operationId: 'conversations.delete',
		'x-cli-destructive': true,
		tags: TAGS,
		summary: 'Delete a conversation',
		request: { params: Params },
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: z.object({ deleted: z.literal(true) }) }),
				'Conversation deleted',
			),
			...errorResponses(401, 403, 404, 409),
		},
	}),
	async (c) => ok(c, await deleteConversation({ ...context(c), ...c.req.valid('param') })),
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations/{cid}/messages',
		operationId: 'conversations.send',
		tags: TAGS,
		summary: 'Send a message and wait for the reply',
		description:
			'Runs one assistant turn and returns the saved conversation. Mutating tools that need consent are skipped on this endpoint; use the web UI to approve them.',
		request: { params: Params, body: jsonBody(SendMessageBody) },
		responses: conversationResponses,
	}),
	async (c) =>
		ok(
			c,
			await executeTurn({
				...context(c),
				...c.req.valid('param'),
				content: c.req.valid('json').content,
			}),
		),
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations/{cid}/resume',
		operationId: 'conversations.resume',
		tags: TAGS,
		summary: 'Continue an interrupted task and wait for the reply',
		request: { params: Params, body: jsonBody(ResumeConversationBody) },
		responses: conversationResponses,
	}),
	async (c) =>
		ok(
			c,
			await executeTurn({
				...context(c),
				...c.req.valid('param'),
				resume: true,
				acknowledgeUncertain: c.req.valid('json').acknowledge_uncertain,
			}),
		),
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations/{cid}/stream',
		operationId: 'conversations.stream',
		'x-cli-hidden': true,
		tags: TAGS,
		summary: 'Send a message and stream the reply',
		description:
			'Runs one turn and streams the assistant reply as an AI SDK UI message stream (server-sent events). The turn keeps running if the client disconnects; reconnect with GET …/stream or reload the conversation.',
		request: { params: Params, body: jsonBody(StreamTurnBody) },
		responses: {
			200: {
				description: 'UI message stream for the assistant reply',
				content: { 'text/event-stream': { schema: z.string() } },
			},
			...errorResponses(400, 401, 403, 404, 409, 422, 503),
		},
	}),
	async (c) => {
		const body = c.req.valid('json');
		const deps = c.get('deps');
		const params = c.req.valid('param');
		const turn = streamTurn({
			...context(c),
			...params,
			...(body.resume === true
				? { resume: true, acknowledgeUncertain: body.acknowledge_uncertain }
				: { content: body.content }),
		});
		// The turn reports its own failures to the client stream.
		void deferOrAwait(
			deps.backgroundWork,
			'conversation.turn',
			() => turn.done.catch(() => {}),
			deps.metrics,
			{ project_id: params.pid, conversation_id: params.cid },
		);
		await turn.started;
		return createUIMessageStreamResponse({ stream: turn.stream });
	},
);

app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/conversations/{cid}/stream',
		operationId: 'conversations.reconnect',
		'x-cli-hidden': true,
		tags: TAGS,
		summary: 'Re-attach to the running reply',
		description:
			'Replays the chunks streamed so far for the turn running on this instance and follows it live. Responds 204 when no turn runs here; the saved conversation then carries the progress.',
		request: { params: Params },
		responses: {
			200: {
				description: 'UI message stream for the running reply',
				content: { 'text/event-stream': { schema: z.string() } },
			},
			204: { description: 'No reply is streaming on this instance' },
			...errorResponses(401, 403, 404),
		},
	}),
	async (c) => {
		const stream = await reconnectTurn({ ...context(c), ...c.req.valid('param') });
		if (!stream) return c.body(null, 204);
		return createUIMessageStreamResponse({ stream });
	},
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations/{cid}/stop',
		operationId: 'conversations.stop',
		tags: TAGS,
		summary: 'Stop the running reply',
		description:
			'Stops the turn running for this conversation on any instance. Completed tool results stay saved and the task can be continued. Returns stopped=false when no turn is running.',
		request: { params: Params },
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: z.object({ stopped: z.boolean() }) }),
				'Stop request outcome',
			),
			...errorResponses(401, 403, 404),
		},
	}),
	async (c) => ok(c, await stopConversation({ ...context(c), ...c.req.valid('param') })),
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations/{cid}/continuation/dismiss',
		operationId: 'conversations.dismiss',
		tags: TAGS,
		summary: 'Discard the saved task without continuing it',
		request: { params: Params },
		responses: conversationResponses,
	}),
	async (c) => ok(c, await dismissContinuation({ ...context(c), ...c.req.valid('param') })),
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/conversations/{cid}/permissions/{rid}',
		operationId: 'conversations.permissions.decide',
		'x-cli-hidden': true,
		tags: TAGS,
		summary: 'Answer a tool consent request',
		request: { params: Params.extend({ rid: z.uuid() }), body: jsonBody(PermissionDecisionBody) },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: z.object({ accepted: z.boolean(), reason: z.literal('closed').optional() }),
				}),
				'Permission decision outcome',
			),
			...errorResponses(400, 401, 403, 404),
		},
	}),
	async (c) =>
		ok(
			c,
			await decidePermission({
				...context(c),
				...c.req.valid('param'),
				...c.req.valid('json'),
			}),
		),
);

app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/chat-permissions',
		operationId: 'chat-permissions.list',
		tags: TAGS,
		summary: 'List remembered tool permissions',
		request: { params: ProjectIdParam },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: z.object({ grants: z.array(ChatPermissionGrantSchema).max(200) }),
				}),
				'Remembered permissions',
			),
			...errorResponses(401, 403, 404),
		},
	}),
	async (c) => ok(c, await listChatPermissions({ ...context(c), ...c.req.valid('param') })),
);

app.openapi(
	createRoute({
		method: 'delete',
		path: '/projects/{pid}/chat-permissions/{grant_id}',
		operationId: 'chat-permissions.revoke',
		tags: TAGS,
		summary: 'Forget a remembered tool permission',
		request: { params: ProjectIdParam.extend({ grant_id: z.uuid() }) },
		responses: {
			200: jsonContent(
				z.object({ success: z.literal(true), data: z.object({ removed: z.boolean() }) }),
				'Permission removal outcome',
			),
			...errorResponses(400, 401, 403, 404),
		},
	}),
	async (c) => ok(c, await revokeChatPermission({ ...context(c), ...c.req.valid('param') })),
);

export default app;
