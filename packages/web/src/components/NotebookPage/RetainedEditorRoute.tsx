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
	const [ready, setReady] = useState(false);
	if (active && retained !== location) {
		setRetained(location);
		if (retained?.pathname !== location.pathname) setReady(false);
	}
	if (!active && retained && !ready) setRetained(null);
	useEffect(() => {
		if (active || !retained) return;
		const timer = setTimeout(() => setRetained(null), EDITOR_RETENTION_MS);
		return () => clearTimeout(timer);
	}, [active, retained]);
	return (
		<>
			{retained ? (
				<Activity mode={active ? 'visible' : 'hidden'}>
					<RetainedEditorContext value={setReady}>
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
