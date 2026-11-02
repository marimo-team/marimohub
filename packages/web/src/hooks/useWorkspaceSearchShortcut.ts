import { isSearchPath, SEARCH_ROUTE } from '@/lib/workspaceSearch';
import { isAppleKeyboard } from '@/lib/keyboard';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export function useWorkspaceSearchShortcut(enabled: boolean) {
	const navigate = useNavigate();
	const location = useLocation();
	useEffect(() => {
		if (!enabled) return;
		const handleKey = (event: KeyboardEvent) => {
			const apple = isAppleKeyboard();
			if (
				event.defaultPrevented ||
				event.isComposing ||
				event.repeat ||
				event.key.toLowerCase() !== 'k' ||
				event.altKey ||
				event.shiftKey ||
				(apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)
			)
				return;
			event.preventDefault();
			const searching = isSearchPath(location.pathname);
			void navigate(searching ? location.pathname + location.search : SEARCH_ROUTE, {
				state: { focusSearch: true },
				replace: searching,
			});
		};
		document.addEventListener('keydown', handleKey);
		return () => document.removeEventListener('keydown', handleKey);
	}, [enabled, location.pathname, location.search, navigate]);
}
