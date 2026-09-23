import {
	Connect,
	NAMESPACE,
	QUERY_CAPABILITY,
	TITLE_CAPABILITY,
	Ready,
	UPDATE_INTERVAL_MS,
	VERSION,
	compatible,
	exactOrigin,
	randomIdentifier,
} from './protocol';
import type {
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

export interface HostBridgeOptions extends StatusOptions {
	iframe: HTMLIFrameElement;
	origin: string;
	excludedKeys?: readonly string[];
	onQuery(snapshot: QuerySnapshot): boolean;
	onTitle?: (title: string) => boolean;
}

export function createHostBridge(options: HostBridgeOptions): BridgeHandle {
	const { iframe } = options;
	const origin = exactOrigin(options.origin);
	const win = iframe.ownerDocument.defaultView!;
	const excludedKeys = [...new Set(options.excludedKeys ?? [])];
	let status: BridgeStatus = 'connecting';
	let channel: ReturnType<typeof createChannelRpc<NotebookApi, HostApi>> | undefined;
	let documentId: string | undefined;
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
		const syncTitle = !!options.onTitle && parsed.data.capabilities.includes(TITLE_CAPABILITY);
		const connect = Connect.safeParse({
			namespace: NAMESPACE,
			kind: 'connect',
			version: VERSION,
			capabilities: [QUERY_CAPABILITY, ...(syncTitle ? [TITLE_CAPABILITY] : [])],
			documentId,
			connectionId,
			excludedKeys,
		});
		if (!connect.success) {
			unavailable();
			return;
		}
		const ports = new MessageChannel();
		const isActive = () => channel === current && status === 'connected';
		const receiveQuery = createSnapshotReceiver(isActive);
		const receiveTitle = createSnapshotReceiver(() => syncTitle && isActive());
		const current = createChannelRpc<NotebookApi, HostApi>(ports.port1, connectionId, 'host', {
			replaceTitle({ revision, title }) {
				return receiveTitle(revision, title, () => options.onTitle?.(title) ?? false);
			},
			replaceQuery(snapshot) {
				const entries = [...notebookQueryParams(snapshot.entries, excludedKeys)];
				return receiveQuery(snapshot.revision, new URLSearchParams(entries).toString(), () =>
					options.onQuery({ ...snapshot, entries }),
				);
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

function createSnapshotReceiver(isActive: () => boolean) {
	let revision = -1;
	let lastApplied = -Infinity;
	let lastValue: string | undefined;
	return (nextRevision: number, value: string, apply: () => boolean) => {
		const now = Date.now();
		if (!isActive() || nextRevision <= revision || now - lastApplied < UPDATE_INTERVAL_MS)
			return { applied: false };
		revision = nextRevision;
		if (value === lastValue) return { applied: true };
		lastApplied = now;
		const applied = apply();
		if (applied) lastValue = value;
		return { applied };
	};
}
