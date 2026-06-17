import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Press `/` anywhere on the page to jump to a search box (GitHub-style). No-op
 * while the user is already typing in a field, and ignores the key when a
 * modifier is held so it never hijacks browser/OS shortcuts.
 */
export function useSearchHotkey(ref: RefObject<HTMLInputElement | null>): void {
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;

			const active = document.activeElement as HTMLElement | null;
			const tag = active?.tagName;
			const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable === true;
			if (isTyping) return;

			event.preventDefault();
			ref.current?.focus();
		}

		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [ref]);
}
