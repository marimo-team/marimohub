import {
	Connect,
	HANDSHAKE_TIMEOUT_MS,
	NAMESPACE,
	Probe,
	QUERY_CAPABILITY,
	TITLE_CAPABILITY,
	TitleSnapshot,
	QuerySnapshot,
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
	QueryResult,
	StatusOptions,
} from './protocol';
import { notebookQueryParams } from './query';
import { createChannelRpc } from './transport';
import { createHandshakeRetry } from './handshake';

export interface NotebookBridgeOptions extends StatusOptions {
	parentOrigin: string;
	window?: Window;
}
const instances = new WeakMap<Window, BridgeHandle>();

export function startNotebookBridge(options: NotebookBridgeOptions): BridgeHandle {
	const win = options.window ?? window;
	const existing = instances.get(win);
	if (existing) return existing;
	const parentOrigin = exactOrigin(options.parentOrigin);
	const documentId = randomIdentifier(win.crypto);
	let status: BridgeStatus = 'connecting';
	let channel: ReturnType<typeof createChannelRpc<HostApi, NotebookApi>> | undefined;
	let excludedKeys: string[] = [];
	let connectionId: string | undefined;
	let revision = 0;
	let lastSent: { query?: string; title?: string } = {};
	const initialTitle = win.document.title;
	let changedTitle: string | undefined;
	let syncTitle = false;
	let inFlight: { query?: boolean; title?: boolean } = {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let readyTimer: ReturnType<typeof setTimeout> | undefined;
	const updateStatus = (next: BridgeStatus) => {
		status = next;
		options.onStatus?.(next);
	};
	const ready = () => {
		if (status === 'disposed' || win.parent === win) return;
		win.parent.postMessage(
			{
				namespace: NAMESPACE,
				kind: 'ready',
				version: VERSION,
				capabilities: [QUERY_CAPABILITY, TITLE_CAPABILITY],
				documentId,
			},
			parentOrigin,
		);
	};
	const handshake = createHandshakeRetry(ready, () => updateStatus('unavailable'));
	const schedule = () => {
		if (status !== 'connected' || timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			flush();
		}, UPDATE_INTERVAL_MS);
	};
	const flush = () => {
		const current = channel;
		if (status !== 'connected' || !current) return;
		const params = notebookQueryParams(win.location.search, excludedKeys);
		const search = params.toString();
		const title = syncTitle ? changedTitle : undefined;
		const track = (key: keyof typeof lastSent, value: string, request: Promise<QueryResult>) => {
			inFlight[key] = true;
			void request
				.then(({ applied }) => {
					if (channel === current && applied) lastSent[key] = value;
				})
				.catch(() => {
					if (channel !== current || status === 'disposed') return;
					if (key === 'title') {
						syncTitle = false;
					} else {
						current.dispose();
						channel = undefined;
						updateStatus('unavailable');
					}
				})
				.finally(() => {
					if (channel === current) {
						inFlight[key] = false;
						schedule();
					}
				});
		};
		if (!inFlight.query && search !== lastSent.query) {
			const parsed = QuerySnapshot.safeParse({ revision: ++revision, entries: [...params] });
			if (parsed.success) {
				track('query', search, current.rpc.replaceQuery(parsed.data));
			}
		}
		if (!inFlight.title && title !== undefined && title !== lastSent.title) {
			const parsed = TitleSnapshot.safeParse({ revision: ++revision, title });
			if (parsed.success) {
				track('title', title, current.rpc.replaceTitle(parsed.data));
			}
		}
	};
	const onMessage = (event: MessageEvent) => {
		if (status === 'disposed' || event.source !== win.parent || event.origin !== parentOrigin)
			return;
		if (Probe.safeParse(event.data).success) {
			ready();
			return;
		}
		const parsed = Connect.safeParse(event.data);
		if (!parsed.success) return;
		if (
			parsed.data.documentId !== documentId ||
			event.ports.length !== 1 ||
			!compatible(parsed.data) ||
			parsed.data.connectionId === connectionId
		) {
			for (const port of event.ports) port.close();
			return;
		}
		connectionId = parsed.data.connectionId;
		channel?.dispose();
		clearTimeout(timer);
		timer = undefined;
		clearTimeout(readyTimer);
		handshake.stop();
		excludedKeys = parsed.data.excludedKeys;
		lastSent = {};
		syncTitle = parsed.data.capabilities.includes(TITLE_CAPABILITY);
		inFlight = {};
		updateStatus('connecting');
		channel = createChannelRpc<HostApi, NotebookApi>(
			event.ports[0],
			parsed.data.connectionId,
			'notebook',
			{
				connected() {
					clearTimeout(readyTimer);
					updateStatus('connected');
					schedule();
					return { ready: true };
				},
			},
		);
		readyTimer = setTimeout(() => {
			channel?.dispose();
			channel = undefined;
			updateStatus('unavailable');
		}, HANDSHAKE_TIMEOUT_MS);
	};
	const originalPush = win.history.pushState;
	const originalReplace = win.history.replaceState;
	const wrap = (original: History['pushState']): History['pushState'] =>
		function (this: History, ...args) {
			const result = original.apply(this, args);
			schedule();
			return result;
		};
	const push = wrap(originalPush);
	const replace = wrap(originalReplace);
	win.history.pushState = push;
	win.history.replaceState = replace;
	win.addEventListener('message', onMessage);
	win.addEventListener('popstate', schedule);
	const titleObserver = new MutationObserver(() => {
		const title = win.document.title;
		if (title === (changedTitle ?? initialTitle)) return;
		changedTitle = title;
		schedule();
	});
	titleObserver.observe(win.document.head, { childList: true, subtree: true, characterData: true });
	const handle: BridgeHandle = {
		get status() {
			return status;
		},
		dispose() {
			if (status === 'disposed') return;
			clearTimeout(timer);
			clearTimeout(readyTimer);
			handshake.stop();
			channel?.dispose();
			channel = undefined;
			win.removeEventListener('message', onMessage);
			win.removeEventListener('popstate', schedule);
			titleObserver.disconnect();
			if (win.history.pushState === push) win.history.pushState = originalPush;
			if (win.history.replaceState === replace) win.history.replaceState = originalReplace;
			instances.delete(win);
			updateStatus('disposed');
		},
	};
	instances.set(win, handle);
	if (win.parent === win) updateStatus('unavailable');
	else handshake.start();
	return handle;
}
