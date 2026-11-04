import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { Chat, useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import type { paths } from '@marimo-hub/client';
import { withBasePath } from '@/lib/basePath';
import { apiClient, apiData } from './client';
import { projectKeys } from './queryKeys';

type ConversationResult =
	paths['/api/v1/projects/{pid}/conversations/{cid}']['get']['responses'][200]['content']['application/json']['data'];
export type Conversation = ConversationResult['conversation'];
export type ConversationMessage = Conversation['messages'][number];
export type ConversationPart = ConversationMessage['parts'][number];
export type ConversationPermission = Extract<ConversationPart, { type: 'data-permission' }>['data'];
export type ConversationContinuation = NonNullable<Conversation['continuation']>;
export type ConversationSummary =
	paths['/api/v1/projects/{pid}/conversations']['get']['responses'][200]['content']['application/json']['data']['conversations'][number];
export type ChatPermissionGrant =
	paths['/api/v1/projects/{pid}/chat-permissions']['get']['responses'][200]['content']['application/json']['data']['grants'][number];
export type PermissionDecision = 'allow' | 'always' | 'deny';

/** Stored parts already use the AI SDK part shapes, so one message type serves both. */
export type ChatUIMessage = UIMessage<
	ConversationMessage['metadata'],
	{ permission: ConversationPermission; 'working-notebook': { notebook_id: string } }
>;

export const conversationKeys = {
	list: (pid: string) => ['conversations', pid] as const,
	detail: (pid: string, cid: string) => ['conversations', pid, cid] as const,
	permissions: (pid: string) => ['chat-permissions', pid] as const,
};

export function isTurnPending(conversation: Pick<Conversation, 'pending'> | undefined): boolean {
	return Boolean(conversation?.pending && Date.parse(conversation.pending.expires_at) > Date.now());
}

export function toUIMessages(conversation: Pick<Conversation, 'messages'>): ChatUIMessage[] {
	return conversation.messages.map((message) => message as ChatUIMessage);
}

function streamUrl(pid: string, cid: string): string {
	return withBasePath(
		`/api/v1/projects/${encodeURIComponent(pid)}/conversations/${encodeURIComponent(cid)}/stream`,
	);
}

export function useConversations(pid: string, options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: conversationKeys.list(pid),
		enabled: options.enabled ?? true,
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/conversations', {
					params: { path: { pid } },
					signal,
				}),
			),
	});
}

export function useConversation(
	pid: string,
	cid: string | null,
	options: { pollWhileSending?: boolean; suspendPolling?: boolean } = {},
) {
	return useQuery({
		queryKey: conversationKeys.detail(pid, cid ?? ''),
		queryFn: ({ signal }) => {
			if (!cid) throw new Error('Select a conversation first');
			return apiData(
				apiClient.GET('/api/v1/projects/{pid}/conversations/{cid}', {
					params: { path: { pid, cid } },
					signal,
				}),
			);
		},
		enabled: Boolean(cid),
		// While a turn runs elsewhere (another tab, another replica) the saved record
		// is the only view of progress, so poll it; a live stream in this tab supersedes it.
		refetchInterval: (query) => {
			if (options.suspendPolling) return false;
			return options.pollWhileSending || isTurnPending(query.state.data?.conversation)
				? 1500
				: false;
		},
	});
}

/** A finished turn may have changed anything in the project; refresh what this pid owns. */
export async function refreshProject(client: QueryClient, pid: string, cid: string) {
	await Promise.all([
		client.invalidateQueries({
			predicate: ({ queryKey }) =>
				queryKey[0] !== 'conversations' &&
				queryKey.some(
					(part) =>
						part === pid ||
						(typeof part === 'object' &&
							part !== null &&
							'projectId' in part &&
							part.projectId === pid),
				),
		}),
		client.invalidateQueries({ queryKey: projectKeys.list() }),
		client.invalidateQueries({ queryKey: conversationKeys.list(pid), exact: true }),
		client.invalidateQueries({ queryKey: conversationKeys.detail(pid, cid), exact: true }),
	]);
}

function refreshConversation(client: QueryClient, pid: string, cid?: string) {
	if (cid)
		void client.invalidateQueries({ queryKey: conversationKeys.detail(pid, cid), exact: true });
	void client.invalidateQueries({ queryKey: conversationKeys.list(pid), exact: true });
}

export function useCreateConversation(pid: string) {
	const client = useQueryClient();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: async (title: string) => {
			const result = await apiData(
				apiClient.POST('/api/v1/projects/{pid}/conversations', {
					params: { path: { pid } },
					body: { title: title.slice(0, 120) },
				}),
			);
			client.setQueryData(conversationKeys.detail(pid, result.conversation.id), result);
			return result;
		},
		onSuccess: () => refreshConversation(client, pid),
	});
}

export function useDeleteConversation(pid: string) {
	const client = useQueryClient();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: (cid: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/conversations/{cid}', {
					params: { path: { pid, cid } },
				}),
			),
		onSuccess: async (_result, cid) => {
			client.removeQueries({ queryKey: conversationKeys.detail(pid, cid), exact: true });
			await client.invalidateQueries({ queryKey: conversationKeys.list(pid), exact: true });
		},
	});
}

export function useStopConversation(pid: string) {
	const client = useQueryClient();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: (cid: string) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/conversations/{cid}/stop', {
					params: { path: { pid, cid } },
				}),
			),
		onSuccess: (_result, cid) => refreshConversation(client, pid, cid),
	});
}

export function useUpdateConversation(pid: string) {
	const client = useQueryClient();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: (input: { cid: string; working_notebook: string | null }) =>
			apiData(
				apiClient.PATCH('/api/v1/projects/{pid}/conversations/{cid}', {
					params: { path: { pid, cid: input.cid } },
					body: { working_notebook: input.working_notebook },
				}),
			),
		onSuccess: (result, input) => {
			client.setQueryData(conversationKeys.detail(pid, input.cid), result);
		},
	});
}

export function useDismissContinuation(pid: string) {
	const client = useQueryClient();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: (cid: string) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/conversations/{cid}/continuation/dismiss', {
					params: { path: { pid, cid } },
				}),
			),
		onSuccess: (result, cid) => {
			client.setQueryData(conversationKeys.detail(pid, cid), result);
			refreshConversation(client, pid);
		},
	});
}

export function useDecidePermission(pid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: { cid: string; rid: string; decision: PermissionDecision }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/conversations/{cid}/permissions/{rid}', {
					params: { path: { pid, cid: input.cid, rid: input.rid } },
					body: { decision: input.decision },
				}),
			),
		onSuccess: (_result, input) => {
			refreshConversation(client, pid, input.cid);
			if (input.decision === 'always')
				void client.invalidateQueries({ queryKey: conversationKeys.permissions(pid), exact: true });
		},
	});
}

export function useChatPermissions(pid: string) {
	return useQuery({
		queryKey: conversationKeys.permissions(pid),
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/chat-permissions', {
					params: { path: { pid } },
					signal,
				}),
			),
	});
}

export function useRevokeChatPermission(pid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (grant_id: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/chat-permissions/{grant_id}', {
					params: { path: { pid, grant_id } },
				}),
			),
		onSuccess: () => client.invalidateQueries({ queryKey: conversationKeys.permissions(pid) }),
	});
}

type TurnBody = { content: string } | { resume: true; acknowledge_uncertain?: boolean };

/** Reads the API error envelope that the transport surfaces as the error message. */
export function chatErrorMessage(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	try {
		const parsed: unknown = JSON.parse(error.message);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			'error' in parsed &&
			typeof parsed.error === 'object' &&
			parsed.error !== null &&
			'message' in parsed.error &&
			typeof parsed.error.message === 'string'
		)
			return parsed.error.message;
	} catch {
		// Not an envelope; fall through to the raw message.
	}
	return error.message || fallback;
}

export interface ConversationChatCallbacks {
	onFinish?: (cid: string) => void;
	/** `cid` names the session the error came from; a superseded session may still report. */
	onError?: (error: Error, cid: string) => void;
	onWorkingNotebook?: (notebookId: string, cid: string) => void;
}

interface ChatSession {
	cid: string;
	resume: boolean;
	chat: Chat<ChatUIMessage>;
}

function createSession(
	pid: string,
	conversation: Conversation,
	callbacks: RefObject<ConversationChatCallbacks>,
	failed: RefObject<boolean>,
): ChatSession {
	const cid = conversation.id;
	const api = streamUrl(pid, cid);
	const pending = isTurnPending(conversation);
	const seed = toUIMessages(conversation);
	// A reply still in progress is re-streamed from its first chunk on reconnect,
	// so seed without it to avoid a duplicate; when no instance replays it (204),
	// the record poll restores the saved partial.
	const inProgress = pending && seed.at(-1)?.role === 'assistant';
	return {
		cid,
		resume: pending,
		chat: new Chat<ChatUIMessage>({
			id: cid,
			messages: inProgress ? seed.slice(0, -1) : seed,
			transport: new DefaultChatTransport<ChatUIMessage>({
				api,
				prepareSendMessagesRequest: ({ body }) => ({ api, body: body as TurnBody }),
				prepareReconnectToStreamRequest: () => ({ api }),
			}),
			onFinish: () => callbacks.current.onFinish?.(cid),
			onError: (error) => {
				failed.current = true;
				callbacks.current.onError?.(error, cid);
			},
			onData: (part) => {
				if (part.type === 'data-working-notebook')
					callbacks.current.onWorkingNotebook?.(part.data.notebook_id, cid);
			},
		}),
	};
}

/** One AI SDK chat session per conversation, seeded from the saved record. */
export function useConversationChat(
	pid: string,
	/** The loaded record for the selected conversation; undefined until it has loaded. */
	conversation: Conversation | undefined,
	callbacks: ConversationChatCallbacks,
) {
	const latest = useRef(callbacks);
	useEffect(() => {
		latest.current = callbacks;
	});
	const failed = useRef(false);
	const cid = conversation?.id ?? null;
	const [session, setSession] = useState<ChatSession | null>(null);
	// A session is created when its record first arrives and dropped with the
	// selection. A pending record re-attaches to the live stream; until that
	// settles (replayed, 204, or failed) the caller must not sync the store from
	// the record, or the saved partial comes back beside the replay.
	const [resuming, setResuming] = useState(false);
	const current = useRef<ChatSession | null>(null);
	useEffect(() => {
		if (session && session.cid !== cid) {
			// The server keeps the turn; only this tab's view of it is dropped.
			void session.chat.stop();
			current.current = null;
			setSession(null);
			setResuming(false);
		}
		if (cid && conversation && session?.cid !== cid) {
			const next = createSession(pid, conversation, latest, failed);
			current.current = next;
			setSession(next);
			if (next.resume) {
				setResuming(true);
				void next.chat
					.resumeStream()
					.catch(() => {})
					.finally(() => {
						// A superseded session must not clear the flag for the one now reconnecting.
						if (current.current === next) setResuming(false);
					});
			}
		}
	}, [pid, cid, conversation, session]);
	const active = session?.cid === cid ? session : null;
	const fallback = useMemo(
		() =>
			new Chat<ChatUIMessage>({
				id: 'none',
				messages: [],
				transport: new DefaultChatTransport<ChatUIMessage>({ api: streamUrl(pid, 'none') }),
			}),
		[pid],
	);
	// Re-rendering Markdown for every token is wasteful; batch store updates.
	const helpers = useChat({ chat: active?.chat ?? fallback, throttle: 80 });
	const live = helpers.status === 'submitted' || helpers.status === 'streaming';
	const { sendMessage } = helpers;
	const send = useCallback(
		async (content: string) => {
			failed.current = false;
			await sendMessage({ text: content }, { body: { content } satisfies TurnBody });
			return !failed.current;
		},
		[sendMessage],
	);
	const resume = useCallback(
		async (acknowledgeUncertain: boolean) => {
			failed.current = false;
			await sendMessage(
				{ text: 'Continue the interrupted task.' },
				{ body: { resume: true, acknowledge_uncertain: acknowledgeUncertain } satisfies TurnBody },
			);
			return !failed.current;
		},
		[sendMessage],
	);
	return { ...helpers, ready: active !== null, live, resuming, send, resume };
}
