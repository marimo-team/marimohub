import { subscribeSessionStopped } from '@/api/sessionStop';
import { RetainedEditorContext } from '@/context/RetainedEditorContext';
import { Activity, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { matchPath, Route, Routes, useLocation } from 'react-router-dom';

const EDITOR_PATH = '/projects/:pid/notebooks/:nid';
export const EDITOR_RETENTION_MS = 2 * 60_000;

export function RetainedEditorRoute({
	editor,
	children,
}: {
	editor: ReactNode;
	children: ReactNode;
}) {
	const location = useLocation();
	const active = Boolean(matchPath(EDITOR_PATH, location.pathname));
	const [retained, setRetained] = useState(active ? location : null);
	const [retainedSessionId, setRetainedSessionId] = useState<string>();
	if (active && retained !== location) {
		setRetained(location);
		if (retained?.pathname !== location.pathname) setRetainedSessionId(undefined);
	}
	if (!active && retained && !retainedSessionId) setRetained(null);
	useEffect(() => {
		if (active || !retained) return;
		const match = matchPath(EDITOR_PATH, retained.pathname);
		const evict = () => setRetained(null);
		const timer = setTimeout(evict, EDITOR_RETENTION_MS);
		const unsubscribe = subscribeSessionStopped(({ projectId, notebookId, sessionId }) => {
			if (
				sessionId === retainedSessionId &&
				match?.params.pid === projectId &&
				match.params.nid === notebookId
			) {
				evict();
			}
		});
		return () => {
			clearTimeout(timer);
			unsubscribe();
		};
	}, [active, retained, retainedSessionId]);
	return (
		<>
			{retained ? (
				<Activity mode={active ? 'visible' : 'hidden'}>
					<RetainedEditorContext value={setRetainedSessionId}>
						<Routes location={retained} key={retained.pathname}>
							<Route path={EDITOR_PATH} element={editor} />
						</Routes>
					</RetainedEditorContext>
				</Activity>
			) : null}
			{active ? null : children}
		</>
	);
}
