import { useEffect, useState } from 'react';
import { getHighlighterIfLoaded, preloadHighlighter } from '@pierre/diffs';
import { MultiFileDiff } from '@pierre/diffs/react';
import { Skeleton } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';

interface VersionDiffViewProps {
	fileName: string;
	oldCode: string;
	newCode: string;
}

// Shiki themes shipped with @pierre/diffs; the app's CSS cannot reach inside
// the component's shadow root, so all theming goes through `options`.
const DIFF_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * The shared highlighter is a module singleton that loads async; MultiFileDiff
 * mounted before it resolves renders empty and never repaints (observed with
 * `disableWorkerPool`). Gate the first mount on it instead.
 */
function useHighlighterReady(): boolean {
	const [ready, setReady] = useState(() => getHighlighterIfLoaded() !== undefined);
	useEffect(() => {
		if (ready) return;
		let cancelled = false;
		void preloadHighlighter({
			themes: [DIFF_THEMES.light, DIFF_THEMES.dark],
			langs: ['python'],
		}).then(() => {
			if (!cancelled) setReady(true);
		});
		return () => {
			cancelled = true;
		};
	}, [ready]);
	return ready;
}

/**
 * Side-by-side diff of one notebook file. Kept as the only module importing
 * `@pierre/diffs` so the dialog can `React.lazy` it and the library (plus its
 * shiki grammars) stays out of the main bundle.
 */
export default function VersionDiffView({ fileName, oldCode, newCode }: VersionDiffViewProps) {
	const { theme } = useTheme();
	const ready = useHighlighterReady();

	if (oldCode === newCode) {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				These versions are identical.
			</div>
		);
	}

	if (!ready) {
		return <Skeleton className="h-full w-full" />;
	}

	return (
		<div className="h-full overflow-auto rounded-md border">
			<MultiFileDiff
				oldFile={{ name: fileName, contents: oldCode }}
				newFile={{ name: fileName, contents: newCode }}
				// Main-thread highlighting: one small .py file, not worth Vite worker setup.
				disableWorkerPool
				options={{
					diffStyle: 'split',
					theme: DIFF_THEMES,
					themeType: theme,
					overflow: 'wrap',
					disableFileHeader: true,
				}}
			/>
		</div>
	);
}
