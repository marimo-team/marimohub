import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useSearchHotkey } from '@/hooks/useSearchHotkey';

export interface SearchField {
	query: string;
	setQuery: (query: string) => void;
	/** Wire to `<SearchField inputRef>` so the `/` hotkey can focus it. */
	inputRef: RefObject<HTMLInputElement | null>;
}

export function useSearchField(initialQuery = ''): SearchField {
	const [query, setQuery] = useState(initialQuery);
	const inputRef = useRef<HTMLInputElement>(null);
	useSearchHotkey(inputRef);
	return { query, setQuery, inputRef };
}
