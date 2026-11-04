const PREFIX = 'marimohub.chat.last-conversation.';

/**
 * Remembers the conversation each tab had open per project.
 *
 * Session storage scopes the memory to the tab: a return in the same tab
 * reopens the conversation, a new tab starts at home. Browsers can block
 * storage access, so every failure reads as "nothing remembered".
 */
export const lastConversation = {
	recall(pid: string): string | null {
		return attempt(() => sessionStorage.getItem(PREFIX + pid));
	},
	remember(pid: string, cid: string | null): void {
		attempt(() =>
			cid ? sessionStorage.setItem(PREFIX + pid, cid) : sessionStorage.removeItem(PREFIX + pid),
		);
	},
};

function attempt<T>(action: () => T): T | null {
	try {
		return action();
	} catch {
		return null;
	}
}
