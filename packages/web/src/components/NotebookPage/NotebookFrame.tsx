import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import { appNavigationHref } from '@marimo-hub/notebook-bridge/navigation';
import { createHostBridge, NOTEBOOK_IFRAME_SANDBOX } from '@marimo-hub/notebook-bridge/host';
import { notebookPath } from '@marimo-hub/notebook-bridge/path';
import type {
	AppNavigation,
	BridgeStatus,
	QuerySnapshot,
} from '@marimo-hub/notebook-bridge/protocol';
import { ExternalLink, X } from 'lucide-react';
import { Button, IconButton, LinkButton } from '@/components/ui';
import { useTimeout } from '@/hooks/useTimeout';
import { notebookHomeSearch, trustedSandboxKeys } from '@/lib/notebookUrls';

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
	const navigate = useNavigate();
	const location = useLocation();
	const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>();
	const appBaseUrl = new URL(useHref('/app/'), window.location.origin).href;
	const navigateApp = useEffectEvent((destination: AppNavigation) => {
		void navigate(appNavigationHref(destination));
		onRetry();
	});
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
				sandboxUrl: trusted.href,
				excludedKeys: trustedSandboxKeys(trusted.href),
				appBaseUrl,
				onNavigateApp: (destination) => {
					if (!active) return false;
					active = false;
					navigateApp(destination);
					return true;
				},
				onQuery: (snapshot) => active && receiveQuery(snapshot),
				onStatus: (status) => {
					iframe.dataset.notebookBridgeStatus = status;
					setBridgeStatus(status);
				},
			});
		} catch {
			return;
		}
		return () => {
			active = false;
			bridge?.dispose();
		};
	}, [sandboxUrl, launchSrc, appBaseUrl]);
	const [loaded, setLoaded] = useState(false);
	const [showRecovery, setShowRecovery] = useState(false);
	const [pathHelpDismissed, setPathHelpDismissed] = useState(false);
	// A saved page path that no longer exists still fires load, so the stalled-load help never
	// appears and Retry would reopen the same page.
	const pathUnavailable =
		bridgeStatus === 'unavailable' &&
		notebookPath(location.search) !== undefined &&
		!pathHelpDismissed;

	// Cross-origin failures can also fire load; only offer help while loading is stalled.
	useTimeout(() => setShowRecovery(true), loaded ? null : RECOVERY_DELAY_MS);

	return (
		<div className="flex size-full min-h-0 flex-col">
			{(showRecovery && !loaded) || pathUnavailable ? (
				<output className="flex flex-wrap items-center gap-3 border-b bg-muted/50 px-4 py-2 text-sm">
					<span className="min-w-0 flex-1">
						<span className="font-medium">Notebook not visible?</span>{' '}
						{pathUnavailable
							? 'The saved notebook page did not connect. Open the notebook home page, retry, or open it in a new window.'
							: 'The notebook did not finish loading. Retry or open it in a new window.'}
					</span>
					{pathUnavailable ? (
						<Button
							size="sm"
							onPress={() =>
								void navigate({
									pathname: location.pathname,
									search: notebookHomeSearch(location.search),
									hash: location.hash,
								})
							}
						>
							Open notebook home
						</Button>
					) : null}
					<Button size="sm" onPress={onRetry}>
						Retry
					</Button>
					<LinkButton to={initialSrc} target="_blank" rel="noopener noreferrer" size="sm">
						<ExternalLink className="size-3.5" />
						Open in new window
					</LinkButton>
					<IconButton
						label="Dismiss notebook help"
						onPress={() => {
							setShowRecovery(false);
							setPathHelpDismissed(true);
						}}
					>
						<X className="size-4" />
					</IconButton>
				</output>
			) : null}
			<iframe
				ref={frameRef}
				className="min-h-0 w-full flex-1 border-0"
				src={launchSrc}
				onLoad={() => setLoaded(true)}
				sandbox={NOTEBOOK_IFRAME_SANDBOX}
				referrerPolicy="no-referrer"
				allow="clipboard-read; clipboard-write"
				title={title}
			/>
		</div>
	);
}
