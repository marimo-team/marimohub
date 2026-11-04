import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
	chatErrorMessage,
	conversationKeys,
	toUIMessages,
	useConversations,
	useCreateConversation,
	useDeleteConversation,
	useDecidePermission,
	useDismissContinuation,
	useUpdateConversation,
} from '@/api/conversations';
import type { ConversationSummary } from '@/api/conversations';
import { useCapabilitiesQuery, useProjectContentQueries } from '@/api/hooks';
import { lastConversation } from './lastConversation';
import { findToolEntry, messageToolEntries } from './toolActivityModel';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useProjectChatSession } from './useProjectChatSession';

const PANE_WIDTH_KEY = 'marimohub.chat.notebook-pane-width';

function storedPaneWidth(): number {
	try {
		const value = Number(localStorage.getItem(PANE_WIDTH_KEY));
		return Number.isFinite(value) && value >= 30 && value <= 70 ? value : 50;
	} catch {
		return 50;
	}
}

export function useProjectChatController(pid: string) {
	const [projectQuery, notebooksQuery] = useProjectContentQueries(pid, {});
	const project = projectQuery.data;
	const { data: capabilities } = useCapabilitiesQuery();
	const client = useQueryClient();
	const [params, setParams] = useSearchParams();
	const cid = params.get('conversation');
	const list = useConversations(pid);
	const create = useCreateConversation(pid);
	const remove = useDeleteConversation(pid);
	const decide = useDecidePermission(pid);
	const update = useUpdateConversation(pid);
	const dismiss = useDismissContinuation(pid);
	const [draft, setDraft] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [permissionsOpen, setPermissionsOpen] = useState(false);
	const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
	const [paneWidth, setPaneWidthState] = useState(storedPaneWidth);
	const mounted = useRef(true);
	const activeCid = useRef(cid);
	useLayoutEffect(() => {
		activeCid.current = cid;
	}, [cid]);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const setPaneWidth = (width: number) => {
		setPaneWidthState(width);
		try {
			localStorage.setItem(PANE_WIDTH_KEY, String(width));
		} catch {
			// Storage can be blocked; the width then lasts for this page only.
		}
	};
	const setParam = (key: string, value: string | null, replace = false) => {
		const next = new URLSearchParams(params);
		if (value === null) next.delete(key);
		else next.set(key, value);
		setParams(next, { replace });
	};
	const chat = useProjectChatSession(pid, cid, create.isPending, {
		onError: (cause, lastSent) => {
			if (!mounted.current) return;
			setDraft((current) => current || lastSent);
			setError(chatErrorMessage(cause, 'Unable to send your message.'));
		},
		onWorkingNotebook: () => {
			if (cid) void client.invalidateQueries({ queryKey: conversationKeys.detail(pid, cid) });
			if (params.get('notebook') === '0') setParam('notebook', null, true);
		},
	});
	const { detail, messages, queue, busy, canSend, canQueue } = chat;
	const conversation = detail.data?.conversation;
	const inspect = params.get('inspect');
	// Until the live session has seeded its store, the saved record is the transcript.
	const transcript = messages.length > 0 || !conversation ? messages : toUIMessages(conversation);
	const inspected = inspect ? findToolEntry(transcript, inspect) : undefined;
	// Only call it missing once the session is ready; a stale link must not flash
	// "not found" while the conversation is still loading.
	const inspectMissing = Boolean(
		inspect && cid && conversation?.id === cid && chat.ready && !inspected,
	);
	const setInspect = (toolCallId: string | null) =>
		setParam('inspect', toolCallId === inspect ? null : toolCallId);
	const paneOpen =
		Boolean(cid) &&
		(params.get('notebook') === '1' ||
			(params.get('notebook') !== '0' && Boolean(conversation?.working_notebook)));
	const setPaneOpen = (open: boolean) => setParam('notebook', open ? '1' : '0');
	const scroll = useTranscriptScroll(cid, params.get('message'));
	const alignTranscript = scroll.align;
	const composer = useRef<HTMLTextAreaElement>(null);
	const restored = useRef(false);
	useEffect(() => {
		if (restored.current) return;
		restored.current = true;
		if (cid) return;
		const remembered = lastConversation.recall(pid);
		if (remembered) setParams({ conversation: remembered }, { replace: true });
	}, [cid, pid, setParams]);
	useEffect(() => {
		lastConversation.remember(pid, detail.isError ? null : cid);
	}, [pid, cid, detail.isError]);
	useEffect(() => {
		alignTranscript();
	}, [cid, messages, busy, alignTranscript]);
	const latestAssistant = messages.findLast((message) => message.role === 'assistant');
	const latestTools = latestAssistant ? messageToolEntries(latestAssistant) : [];
	const latestWriting = Boolean(
		latestAssistant?.parts.some((part) => part.type === 'text' && part.text.trim()),
	);
	const conversations = list.data?.conversations ?? [];
	const home = !cid || (chat.ready && messages.length === 0 && !busy);
	const canSubmit = canSend || canQueue;
	const select = (id: string | null) => {
		if (id !== null && id === cid) return;
		setParams(id ? { conversation: id } : {});
		setError(null);
		setDraft('');
		chat.clearQueue();
	};
	const report = (cause: unknown, fallback: string) => {
		if (mounted.current) setError(cause instanceof Error ? cause.message : fallback);
	};
	const stopTurn = async () => {
		if (!cid) return;
		try {
			await chat.stop();
		} catch (cause) {
			report(cause, 'Could not stop the response.');
		}
	};
	const submit = async () => {
		const content = draft.trim();
		if (!content || !canSubmit) return;
		setError(null);
		setDraft('');
		if (!canSend) {
			chat.enqueue(content);
			return;
		}
		scroll.follow();
		if (cid) {
			await chat.send(cid, content);
			return;
		}
		try {
			const created = await create.mutateAsync(content);
			if (!mounted.current) return;
			// The new conversation's session mounts on the next render; the queue
			// delivers the message once it is ready.
			chat.enqueue(content);
			setParams({ conversation: created.conversation.id }, { replace: true });
		} catch (cause) {
			if (mounted.current) {
				setDraft((current) => current || content);
				setError(cause instanceof Error ? cause.message : 'Unable to send your message.');
			}
		}
	};
	const resume = async (acknowledgeUncertain: boolean) => {
		if (!cid) return false;
		setError(null);
		try {
			return await chat.resume(cid, acknowledgeUncertain);
		} catch (cause) {
			report(cause, 'Could not continue this task.');
			return false;
		}
	};
	const dismissTask = async () => {
		if (!cid) return;
		try {
			await dismiss.mutateAsync(cid);
		} catch (cause) {
			report(cause, 'Could not dismiss the task.');
		}
	};
	const showNotebook = async (notebookId: string) => {
		if (!cid) return;
		try {
			await update.mutateAsync({ cid, working_notebook: notebookId });
		} catch (cause) {
			report(cause, 'Could not open the notebook.');
			return;
		}
		if (!mounted.current || activeCid.current !== cid) return;
		const next = new URLSearchParams(params);
		next.set('notebook', '1');
		next.delete('inspect');
		setParams(next);
	};
	const setWorkingNotebook = async (notebookId: string | null) => {
		if (!cid) return;
		try {
			await update.mutateAsync({ cid, working_notebook: notebookId });
		} catch (cause) {
			report(cause, 'Could not open the notebook.');
			throw cause;
		}
	};
	const openPane = async () => {
		if (cid) {
			const next = new URLSearchParams(params);
			next.delete('inspect');
			next.set('notebook', paneOpen && !inspect ? '0' : '1');
			setParams(next);
			return;
		}
		try {
			const created = await create.mutateAsync('Notebook chat');
			if (mounted.current) setParams({ conversation: created.conversation.id, notebook: '1' });
		} catch (cause) {
			report(cause, 'Could not create conversation.');
		}
	};
	const deleteSelected = async () => {
		if (!deleting) return;
		try {
			await remove.mutateAsync(deleting.id);
			if (!mounted.current) return;
			if (cid === deleting.id) select(null);
		} catch (cause) {
			report(cause, 'Could not delete conversation.');
		} finally {
			if (mounted.current) setDeleting(null);
		}
	};
	return {
		project,
		notebooks: notebooksQuery.data,
		capabilities,
		cid,
		list,
		detail,
		conversation,
		conversations,
		messages,
		queue,
		busy,
		canSend,
		canQueue,
		canSubmit,
		home,
		live: chat.live,
		latestTools,
		latestWriting,
		draft,
		setDraft,
		error,
		composer,
		scroll,
		historyOpen,
		setHistoryOpen,
		permissionsOpen,
		setPermissionsOpen,
		deleting,
		setDeleting,
		deleteSelected,
		removing: remove.isPending,
		inspect,
		inspected,
		inspectMissing,
		setInspect,
		showNotebook,
		inspectPermalink: cid
			? `/projects/${encodeURIComponent(pid)}/chat?conversation=${encodeURIComponent(cid)}&inspect=${encodeURIComponent(inspect ?? '')}`
			: '',
		paneOpen,
		setPaneOpen,
		paneWidth,
		setPaneWidth,
		openPane,
		setWorkingNotebook,
		creating: create.isPending,
		removeQueued: chat.removeQueued,
		select,
		stopTurn,
		submit,
		resume,
		dismissTask,
		pickPrompt: (prompt: string) => {
			setDraft(prompt);
			composer.current?.focus();
		},
		decidePermission: (rid: string, decision: 'allow' | 'always' | 'deny') => {
			if (!cid) return Promise.resolve({ accepted: false });
			return decide.mutateAsync({ cid, rid, decision });
		},
	};
}
