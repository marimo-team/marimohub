import { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Button, IconButton, LinkButton } from '@/components/ui';
import { useTimeout } from '@/hooks/useTimeout';

const RECOVERY_DELAY_MS = 15_000;

export function NotebookFrame({ src, title }: { src?: string; title: string }) {
	const [attempt, setAttempt] = useState(0);
	if (!src) return null;
	return (
		<FrameAttempt
			key={`${src}:${attempt}`}
			src={src}
			title={title}
			onRetry={() => setAttempt((current) => current + 1)}
		/>
	);
}

function FrameAttempt({
	src,
	title,
	onRetry,
}: {
	src: string;
	title: string;
	onRetry: () => void;
}) {
	const [loaded, setLoaded] = useState(false);
	const [showRecovery, setShowRecovery] = useState(false);

	// Cross-origin failures can also fire load; only offer help while loading is stalled.
	useTimeout(() => setShowRecovery(true), loaded ? null : RECOVERY_DELAY_MS);

	return (
		<div className="flex size-full min-h-0 flex-col">
			{showRecovery && !loaded ? (
				<output className="flex flex-wrap items-center gap-3 border-b bg-muted/50 px-4 py-2 text-sm">
					<span className="min-w-0 flex-1">
						<span className="font-medium">Notebook not visible?</span> The notebook did not finish
						loading. Retry or open it in a new window.
					</span>
					<Button size="sm" onPress={onRetry}>
						Retry
					</Button>
					<LinkButton to={src} target="_blank" rel="noopener noreferrer" size="sm">
						<ExternalLink className="size-3.5" />
						Open in new window
					</LinkButton>
					<IconButton label="Dismiss notebook help" onPress={() => setShowRecovery(false)}>
						<X className="size-4" />
					</IconButton>
				</output>
			) : null}
			<iframe
				className="min-h-0 w-full flex-1 border-0"
				src={src}
				onLoad={() => setLoaded(true)}
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
				referrerPolicy="no-referrer"
				allow="clipboard-read; clipboard-write"
				title={title}
			/>
		</div>
	);
}
