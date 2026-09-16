import { useCallback, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { randomIdentifier } from '@marimo-hub/notebook-bridge/protocol';
import type { QuerySnapshot } from '@marimo-hub/notebook-bridge/protocol';
import { mergeNotebookQuery } from '@marimo-hub/notebook-bridge/query';
import type { Theme } from '@/context/ThemeContext';
import { notebookFrameUrl } from '@/lib/notebookUrls';

export function useNotebookFrameLocation(
	sandboxUrl: string | undefined,
	theme: Theme,
	isApp: boolean,
) {
	const location = useLocation();
	const navigate = useNavigate();
	// marimo reads the theme on load; freeze it with the iframe's launch URL.
	const [frame, setFrame] = useState(() => ({
		sandboxUrl,
		theme,
		search: location.search,
		currentSearch: location.search,
		locationKey: location.key,
		frameKey: location.key,
		echo: '',
	}));
	if (frame.sandboxUrl !== sandboxUrl) {
		setFrame({
			sandboxUrl,
			theme,
			search: location.search,
			currentSearch: location.search,
			locationKey: location.key,
			frameKey: location.key,
			echo: '',
		});
	} else if (frame.locationKey !== location.key) {
		// Consume each bridge echo once so history navigation cannot reuse it.
		const mirrored =
			frame.echo !== '' &&
			(location.state as { notebookBridgeEcho?: string } | null)?.notebookBridgeEcho === frame.echo;
		const queryNavigation =
			!mirrored &&
			sandboxUrl !== undefined &&
			notebookFrameUrl(sandboxUrl, frame.currentSearch, frame.theme, isApp) !==
				notebookFrameUrl(sandboxUrl, location.search, frame.theme, isApp);
		setFrame({
			...frame,
			locationKey: location.key,
			currentSearch: location.search,
			// An explicit navigation can return to the unchanged launch URL after mirroring.
			frameKey: queryNavigation ? location.key : frame.frameKey,
			search: queryNavigation ? location.search : frame.search,
			echo: '',
		});
	}
	const onQuery = useCallback(
		(snapshot: QuerySnapshot): boolean => {
			if (!sandboxUrl) return false;
			const trustedKeys = [...new URL(sandboxUrl, window.location.origin).searchParams.keys()];
			const search = mergeNotebookQuery(location.search, snapshot.entries, trustedKeys);
			if (search === location.search) return true;
			const echo = randomIdentifier(crypto);
			setFrame((current) => ({ ...current, echo }));
			void navigate(
				{ pathname: location.pathname, search, hash: location.hash },
				{
					replace: true,
					state: {
						...(location.state as Record<string, unknown> | null),
						notebookBridgeEcho: echo,
					},
				},
			);
			return true;
		},
		[location, navigate, sandboxUrl],
	);
	return {
		frameKey: frame.frameKey,
		iframeSrc: frame.sandboxUrl
			? notebookFrameUrl(frame.sandboxUrl, frame.search, frame.theme, isApp)
			: undefined,
		latestSrc: sandboxUrl
			? notebookFrameUrl(sandboxUrl, location.search, frame.theme, isApp)
			: undefined,
		onQuery,
	};
}
