import { createContext } from 'react';

export const RetainedEditorContext = createContext<((sessionId?: string) => void) | undefined>(
	undefined,
);
