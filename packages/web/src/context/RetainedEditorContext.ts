import { createContext } from 'react';

export const RetainedEditorContext = createContext<((ready: boolean) => void) | undefined>(
	undefined,
);
