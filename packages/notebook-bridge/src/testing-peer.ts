import { NAMESPACE } from './protocol';

export interface WireRequest {
	t: 'q';
	i: string;
	m: string;
	a: unknown[];
}

export function wirePeer(port: MessagePort, connectionId: string) {
	const requests: WireRequest[] = [];
	const waiting: ((request: WireRequest) => void)[] = [];
	const responses = new Map<string, (result: unknown) => void>();
	let id = 0;
	const send = (packet: unknown) =>
		port.postMessage(JSON.stringify({ namespace: NAMESPACE, connectionId, packet }));
	port.onmessage = (event) => {
		const { packet } = JSON.parse(event.data) as {
			packet: WireRequest | { t: 's'; i: string; r: unknown };
		};
		if (packet.t === 'q') {
			const resolve = waiting.shift();
			if (resolve) resolve(packet);
			else requests.push(packet);
		} else {
			responses.get(packet.i)?.(packet.r);
			responses.delete(packet.i);
		}
	};
	return {
		requests,
		send,
		nextRequest() {
			const request = requests.shift();
			return request
				? Promise.resolve(request)
				: new Promise<WireRequest>((resolve) => {
						waiting.push(resolve);
					});
		},
		reply(request: WireRequest, result: unknown) {
			send({ t: 's', i: request.i, r: result });
		},
		call(method: string, ...args: unknown[]) {
			const key = String(++id);
			return new Promise<unknown>((resolve) => {
				responses.set(key, resolve);
				send({ t: 'q', i: key, m: method, a: args });
			});
		},
	};
}
