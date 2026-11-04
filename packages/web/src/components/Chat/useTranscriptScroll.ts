import { useCallback, useLayoutEffect, useRef } from 'react';
import type { UIEvent, WheelEvent } from 'react';

export function useTranscriptScroll(
	conversationId: string | null,
	messageId: string | null = null,
) {
	const transcript = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const pendingMessage = useRef(messageId);
	const dimensions = useRef({ height: 0, total: 0 });

	const align = useCallback(() => {
		if (!conversationId) return;
		const element = transcript.current;
		if (!element) return;
		if (pendingMessage.current) {
			const target = document.getElementById(`chat-message-${pendingMessage.current}`);
			if (target && element.contains(target)) {
				following.current = false;
				target.scrollIntoView({ block: 'center' });
				pendingMessage.current = null;
			}
		}
		if (following.current) element.scrollTo({ top: element.scrollHeight });
		dimensions.current = { height: element.clientHeight, total: element.scrollHeight };
	}, [conversationId]);
	const follow = () => {
		following.current = true;
		align();
	};
	const onScroll = (event: UIEvent<HTMLElement>) => {
		const element = event.currentTarget;
		const previous = dimensions.current;
		const resized =
			previous.height > 0 &&
			(previous.height !== element.clientHeight || previous.total !== element.scrollHeight);
		dimensions.current = { height: element.clientHeight, total: element.scrollHeight };
		// Layout-driven scrolling must not be mistaken for the reader moving away from the end.
		if (!resized)
			following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
	};
	const onWheel = (event: WheelEvent<HTMLElement>) => {
		if (event.deltaY < 0) following.current = false;
	};

	useLayoutEffect(() => {
		const element = transcript.current;
		if (!element) return;
		following.current = Boolean(conversationId) && !messageId;
		pendingMessage.current = messageId;
		if (!conversationId) {
			element.scrollTo({ top: 0 });
			return;
		}
		const observer = new ResizeObserver(align);
		observer.observe(element);
		if (content.current) observer.observe(content.current);
		align();
		return () => observer.disconnect();
	}, [conversationId, messageId, align]);

	return { transcript, content, align, follow, onScroll, onWheel };
}
