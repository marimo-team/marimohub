import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
	conversationKeys,
	isTurnPending,
	refreshProject,
	toUIMessages,
	useConversation,
	useConversationChat,
	useStopConversation,
} from '@/api/conversations';

/**
 * Joins the saved record and the live AI SDK session for one conversation. The
 * SDK store is the source of truth while this tab streams; the record takes over
 * once the server has finalized the turn, so a stale snapshot never erases live
 * output or resurrects an already-finished turn.
 */
export function useProjectChatSession(
	pid: string,
	cid: string | null,
	creating: boolean,
	callbacks: {
		onError: (error: Error, lastSent: string) => void;
		onWorkingNotebook?: (notebookId: string) => void;
	},
) {
	const client = useQueryClient();
	const lastSent = useRef('');
	const [localTurn, setLocalTurn] = useState<{ cid: string; baseline: number } | null>(null);
	// Each entry remembers its conversation so a history navigation that changes
	// `cid` without `select()` cannot deliver it to the wrong conversation.
	const [queue, setQueue] = useState<{ id: string; cid: string; text: string }[]>([]);
	const queued = useMemo(() => queue.filter((item) => item.cid === cid), [queue, cid]);
	const [live, setLive] = useState(false);
	const detail = useConversation(pid, cid, {
		pollWhileSending: creating,
		suspendPolling: live,
	});
	const conversation = detail.data?.conversation;
	const chat = useConversationChat(pid, conversation?.id === cid ? conversation : undefined, {
		onFinish: (finishedCid) => {
			// Also for a re-attached stream: the record still shows the turn as
			// pending, so hold the live result until a newer snapshot arrives.
			const baseline =
				client.getQueryState(conversationKeys.detail(pid, finishedCid))?.dataUpdatedAt ?? 0;
			setLocalTurn({ cid: finishedCid, baseline });
			void refreshProject(client, pid, finishedCid);
		},
		onError: (error, fromCid) => {
			if (fromCid !== cid) return;
			setLocalTurn(null);
			callbacks.onError(error, lastSent.current);
		},
		onWorkingNotebook: (notebookId, fromCid) => {
			if (fromCid === cid) callbacks.onWorkingNotebook?.(notebookId);
		},
	});
	useEffect(() => {
		setLive(chat.live);
	}, [chat.live]);
	const stop = useStopConversation(pid);
	const recordPending = isTurnPending(conversation);
	// A finished stream can precede both the refreshed record and release of its claim.
	const awaitingSnapshot =
		localTurn?.cid === cid && (detail.dataUpdatedAt <= localTurn.baseline || recordPending);
	const { setMessages } = chat;
	const streaming = chat.live;
	const { resuming } = chat;
	useEffect(() => {
		if (streaming || resuming || awaitingSnapshot || !conversation || conversation.id !== cid)
			return;
		setMessages(toUIMessages(conversation));
	}, [conversation, cid, streaming, resuming, awaitingSnapshot, setMessages]);
	const busy = chat.live || creating || recordPending || awaitingSnapshot;
	const conversationReady = !detail.isError && (!cid || (!detail.isPending && chat.ready));
	const canSend = !busy && conversationReady;
	const canQueue = chat.live && Boolean(cid) && conversationReady;
	const { send: sendMessage } = chat;
	const send = useCallback(
		(id: string, content: string) => {
			setLocalTurn({
				cid: id,
				baseline: client.getQueryState(conversationKeys.detail(pid, id))?.dataUpdatedAt ?? 0,
			});
			lastSent.current = content;
			return sendMessage(content);
		},
		[client, pid, sendMessage],
	);
	// onFinish can precede SDK readiness and server finalization; queue dispatch waits for both.
	useEffect(() => {
		// A new conversation's message is queued before the URL carries its id, so
		// only prune once a conversation is selected.
		if (!cid) return;
		if (queue.length !== queued.length) {
			setQueue(queued);
			return;
		}
		if (!canSend || queue.length === 0) return;
		const [next, ...rest] = queue;
		if (!next) return;
		setQueue(rest);
		void send(cid, next.text);
	}, [canSend, queue, queued, cid, send]);
	return {
		detail,
		ready: chat.ready,
		messages: chat.messages,
		live: chat.live,
		busy,
		canSend,
		canQueue,
		queue: queued,
		clearQueue: () => setQueue([]),
		enqueue: (text: string, forCid: string | null = cid) => {
			if (!forCid) return;
			setQueue((current) => [...current, { id: crypto.randomUUID(), cid: forCid, text }]);
		},
		removeQueued: (id: string) => setQueue((current) => current.filter((item) => item.id !== id)),
		send,
		resume(id: string, acknowledgeUncertain: boolean) {
			setLocalTurn({
				cid: id,
				baseline: client.getQueryState(conversationKeys.detail(pid, id))?.dataUpdatedAt ?? 0,
			});
			// A failed continuation has no message to restore as the draft.
			lastSent.current = '';
			return chat.resume(acknowledgeUncertain);
		},
		async stop() {
			if (!cid) return;
			setQueue([]);
			try {
				await stop.mutateAsync(cid);
			} finally {
				await chat.stop();
				setLocalTurn(null);
			}
		},
	};
}
