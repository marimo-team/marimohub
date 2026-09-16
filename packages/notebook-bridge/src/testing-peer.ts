import { NAMESPACE } from './protocol';

export interface WireRequest {
	t: 'q';
	i: string;
	m: string;
	a: unknown[];
}

interface Pending<T> {
	resolve(value: T): void;
	reject(error: Error): void;
}

export function wirePeer(port: MessagePort, connectionId: string, timeoutMs = 1_000) {
	const requests: WireRequest[] = [];
	const waiting = new Map<string, Pending<WireRequest>>();
	const responses = new Map<string, Pending<unknown>>();
	let id = 0;
	let closed = false;
	const waitFor = <T>(pending: Map<string, Pending<T>>, key: string, operation: string) =>
		new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.get(key)?.reject(new Error(`Wire peer timed out waiting for ${operation}`));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				pending.delete(key);
			};
			pending.set(key, {
				resolve(value) {
					cleanup();
					resolve(value);
				},
				reject(error) {
					cleanup();
					reject(error);
				},
			});
		});
	const send = (packet: unknown) => {
		if (closed) throw new Error('Wire peer is disposed');
		port.postMessage(JSON.stringify({ namespace: NAMESPACE, connectionId, packet }));
	};
	port.onmessage = (event) => {
		const { packet } = JSON.parse(event.data) as {
			packet: WireRequest | { t: 's'; i: string; r: unknown };
		};
		if (packet.t === 'q') {
			const pending = waiting.values().next().value;
			if (pending) pending.resolve(packet);
			else requests.push(packet);
		} else {
			responses.get(packet.i)?.resolve(packet.r);
		}
	};
	return {
		requests,
		send,
		nextRequest() {
			if (closed) return Promise.reject(new Error('Wire peer is disposed'));
			const request = requests.shift();
			return request ? Promise.resolve(request) : waitFor(waiting, String(++id), 'a request');
		},
		reply(request: WireRequest, result: unknown) {
			send({ t: 's', i: request.i, r: result });
		},
		call(method: string, ...args: unknown[]) {
			if (closed) return Promise.reject(new Error('Wire peer is disposed'));
			const key = String(++id);
			const result = waitFor(responses, key, method);
			try {
				send({ t: 'q', i: key, m: method, a: args });
			} catch (error) {
				responses.get(key)?.reject(error as Error);
			}
			return result;
		},
		dispose() {
			if (closed) return;
			closed = true;
			port.onmessage = null;
			port.close();
			for (const pending of [...waiting.values(), ...responses.values()]) {
				pending.reject(new Error('Wire peer is disposed'));
			}
			requests.length = 0;
		},
	};
}
