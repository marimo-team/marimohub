import {
	Connect,
	HANDSHAKE_TIMEOUT_MS,
	NAMESPACE,
	Probe,
	QUERY_CAPABILITY,
	QuerySnapshot,
	UPDATE_INTERVAL_MS,
	VERSION,
	compatible,
	exactOrigin,
	randomIdentifier,
} from './protocol';
import type { BridgeHandle, BridgeStatus, HostApi, NotebookApi, StatusOptions } from './protocol';
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
	let lastSent: string | undefined;
	let inFlight = false;
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
				capabilities: [QUERY_CAPABILITY],
				documentId,
			},
			parentOrigin,
		);
	};
	const handshake = createHandshakeRetry(ready, () => updateStatus('unavailable'));
	const schedule = () => {
		if (status !== 'connected' || inFlight || timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			flush();
		}, UPDATE_INTERVAL_MS);
	};
	const flush = () => {
		const current = channel;
		if (status !== 'connected' || !current || inFlight) return;
		const params = notebookQueryParams(win.location.search, excludedKeys);
		const search = params.toString();
		if (search === lastSent) return;
		const parsed = QuerySnapshot.safeParse({ revision: ++revision, entries: [...params] });
		if (!parsed.success) return;
		inFlight = true;
		void current.rpc
			.replaceQuery(parsed.data)
			.then((result) => {
				if (channel === current && result.applied) lastSent = search;
			})
			.catch(() => {
				if (channel === current && status !== 'disposed') {
					current.dispose();
					channel = undefined;
					updateStatus('unavailable');
				}
			})
			.finally(() => {
				if (channel === current) {
					inFlight = false;
					schedule();
				}
			});
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
		lastSent = undefined;
		inFlight = false;
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
