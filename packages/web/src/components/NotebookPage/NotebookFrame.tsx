import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { createHostBridge } from '@marimo-hub/notebook-bridge/host';
import type { QuerySnapshot } from '@marimo-hub/notebook-bridge/protocol';
import { ExternalLink, X } from 'lucide-react';
import { Button, IconButton, LinkButton } from '@/components/ui';
import { useTimeout } from '@/hooks/useTimeout';

const RECOVERY_DELAY_MS = 15_000;

interface NotebookFrameProps {
	src?: string;
	title: string;
	sandboxUrl?: string;
	retrySrc?: string;
	onQuery?: (snapshot: QuerySnapshot) => boolean;
}

export function NotebookFrame({ src, title, sandboxUrl, retrySrc, onQuery }: NotebookFrameProps) {
	const [attempt, setAttempt] = useState(0);
	if (!src) return null;
	return (
		<FrameAttempt
			key={`${src}:${attempt}`}
			initialSrc={retrySrc ?? src}
			title={title}
			sandboxUrl={sandboxUrl}
			onQuery={onQuery}
			onRetry={() => setAttempt((current) => current + 1)}
		/>
	);
}

function FrameAttempt({
	title,
	onRetry,
	sandboxUrl,
	onQuery,
	initialSrc,
}: {
	title: string;
	onRetry: () => void;
	sandboxUrl?: string;
	onQuery?: (snapshot: QuerySnapshot) => boolean;
	initialSrc: string;
}) {
	const [launchSrc] = useState(initialSrc);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const receiveQuery = useEffectEvent((snapshot: QuerySnapshot) => onQuery?.(snapshot) ?? false);
	useLayoutEffect(() => {
		const iframe = frameRef.current;
		if (!iframe || !sandboxUrl) return;
		let bridge: ReturnType<typeof createHostBridge> | undefined;
		let active = true;
		try {
			const trusted = new URL(sandboxUrl, window.location.origin);
			bridge = createHostBridge({
				iframe,
				origin: new URL(launchSrc).origin,
				excludedKeys: [...trusted.searchParams.keys()],
				onQuery: (snapshot) => active && receiveQuery(snapshot),
				onStatus: (status) => {
					iframe.dataset.notebookBridgeStatus = status;
				},
			});
		} catch {
			return;
		}
		return () => {
			active = false;
			bridge?.dispose();
		};
	}, [sandboxUrl, launchSrc]);
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
					<LinkButton to={initialSrc} target="_blank" rel="noopener noreferrer" size="sm">
						<ExternalLink className="size-3.5" />
						Open in new window
					</LinkButton>
					<IconButton label="Dismiss notebook help" onPress={() => setShowRecovery(false)}>
						<X className="size-4" />
					</IconButton>
				</output>
			) : null}
			<iframe
				ref={frameRef}
				className="min-h-0 w-full flex-1 border-0"
				src={launchSrc}
				onLoad={() => setLoaded(true)}
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
				referrerPolicy="no-referrer"
				allow="clipboard-read; clipboard-write"
				title={title}
			/>
		</div>
	);
}
