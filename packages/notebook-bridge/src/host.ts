import {
	Connect,
	NAVIGATION_CAPABILITY,
	NAMESPACE,
	QUERY_CAPABILITY,
	Ready,
	UPDATE_INTERVAL_MS,
	VERSION,
	compatible,
	exactOrigin,
	randomIdentifier,
} from './protocol';
import type {
	AppNavigation,
	BridgeHandle,
	BridgeStatus,
	HostApi,
	NotebookApi,
	QuerySnapshot,
	StatusOptions,
} from './protocol';
import { notebookQueryParams } from './query';
import { createChannelRpc } from './transport';
import { createHandshakeRetry } from './handshake';

// Popups must not inherit the iframe sandbox: Hub's COOP header rejects sandboxed tabs.
export const NOTEBOOK_IFRAME_SANDBOX =
	'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

export interface HostBridgeOptions extends StatusOptions {
	iframe: HTMLIFrameElement;
	origin: string;
	excludedKeys?: readonly string[];
	appBaseUrl?: string;
	onNavigateApp?: (destination: AppNavigation) => boolean;
	onQuery(snapshot: QuerySnapshot): boolean;
}

export function createHostBridge(options: HostBridgeOptions): BridgeHandle {
	const { iframe } = options;
	const origin = exactOrigin(options.origin);
	const win = iframe.ownerDocument.defaultView!;
	const excludedKeys = [...new Set(options.excludedKeys ?? [])];
	let status: BridgeStatus = 'connecting';
	let channel: ReturnType<typeof createChannelRpc<NotebookApi, HostApi>> | undefined;
	let documentId: string | undefined;
	let revision = -1;
	let navigating = false;
	let lastApplied = -Infinity;
	let lastQuery: string | undefined;
	const updateStatus = (next: BridgeStatus) => {
		status = next;
		options.onStatus?.(next);
	};
	const stop = () => {
		handshake.stop();
		channel?.dispose();
		channel = undefined;
		documentId = undefined;
	};
	const unavailable = () => {
		stop();
		updateStatus('unavailable');
	};
	const handshake = createHandshakeRetry(
		() => iframe.contentWindow?.postMessage({ namespace: NAMESPACE, kind: 'probe' }, origin),
		unavailable,
	);
	const restart = () => {
		if (status === 'disposed') return;
		stop();
		if (typeof MessageChannel !== 'function') {
			updateStatus('unavailable');
			return;
		}
		revision = -1;
		navigating = false;
		lastApplied = -Infinity;
		lastQuery = undefined;
		updateStatus('connecting');
		handshake.start();
	};
	const onMessage = (event: MessageEvent) => {
		if (status !== 'connecting' || event.origin !== origin || event.source !== iframe.contentWindow)
			return;
		const parsed = Ready.safeParse(event.data);
		if (!parsed.success) return;
		if (!compatible(parsed.data)) {
			unavailable();
			return;
		}
		if (documentId === parsed.data.documentId) return;
		channel?.dispose();
		documentId = parsed.data.documentId;
		const connectionId = randomIdentifier(win.crypto);
		const navigation = Boolean(
			options.appBaseUrl &&
			options.onNavigateApp &&
			parsed.data.capabilities.includes(NAVIGATION_CAPABILITY),
		);
		const connect = Connect.safeParse({
			namespace: NAMESPACE,
			kind: 'connect',
			version: VERSION,
			capabilities: [QUERY_CAPABILITY, ...(navigation ? [NAVIGATION_CAPABILITY] : [])],
			...(navigation ? { appBaseUrl: options.appBaseUrl } : {}),
			documentId,
			connectionId,
			excludedKeys,
		});
		if (!connect.success) {
			unavailable();
			return;
		}
		const ports = new MessageChannel();
		const current = createChannelRpc<NotebookApi, HostApi>(ports.port1, connectionId, 'host', {
			navigateApp(destination) {
				if (channel !== current || status !== 'connected' || navigating || !navigation)
					return { applied: false };
				// Fence query updates before the router can mount the next app.
				navigating = true;
				try {
					const applied = options.onNavigateApp!({
						...destination,
						entries: [...notebookQueryParams(destination.entries, excludedKeys)],
					});
					navigating = applied;
					return { applied };
				} catch {
					navigating = false;
					return { applied: false };
				}
			},
			replaceQuery(snapshot) {
				if (
					channel !== current ||
					status !== 'connected' ||
					navigating ||
					snapshot.revision <= revision ||
					Date.now() - lastApplied < UPDATE_INTERVAL_MS
				)
					return { applied: false };
				revision = snapshot.revision;
				const entries = [...notebookQueryParams(snapshot.entries, excludedKeys)];
				const query = new URLSearchParams(entries).toString();
				if (query === lastQuery) return { applied: true };
				lastApplied = Date.now();
				const applied = options.onQuery({ ...snapshot, entries });
				if (applied) lastQuery = query;
				return { applied };
			},
		});
		channel = current;
		try {
			iframe.contentWindow?.postMessage(connect.data, origin, [ports.port2]);
		} catch {
			ports.port2.close();
			unavailable();
			return;
		}
		void current.rpc
			.connected()
			.then(() => {
				if (channel !== current || status !== 'connecting') return;
				handshake.stop();
				updateStatus('connected');
			})
			.catch(() => {
				if (channel === current && status !== 'disposed') {
					unavailable();
				}
			});
	};
	win.addEventListener('message', onMessage);
	iframe.addEventListener('load', restart);
	restart();
	return {
		get status() {
			return status;
		},
		dispose() {
			if (status === 'disposed') return;
			stop();
			win.removeEventListener('message', onMessage);
			iframe.removeEventListener('load', restart);
			updateStatus('disposed');
		},
	};
}
