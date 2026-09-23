import { createBirpc } from 'birpc';
import { z } from 'zod';
import {
	ConnectedResult,
	NAMESPACE,
	QueryResult,
	QuerySnapshot,
	TitleSnapshot,
	REQUEST_TIMEOUT_MS,
} from './protocol';
import type { HostApi, NotebookApi } from './protocol';

// This envelope and the birpc v4 packet layout are the frozen v1 wire format.
const Packet = z.discriminatedUnion('t', [
	z.object({
		t: z.literal('q'),
		i: z.string().min(1).max(128),
		m: z.enum(['replaceQuery', 'replaceTitle', 'connected']),
		a: z.array(z.unknown()).max(1),
	}),
	z.object({ t: z.literal('s'), i: z.string().min(1).max(128), r: z.unknown() }),
]);
const Envelope = z.object({
	namespace: z.literal(NAMESPACE),
	connectionId: z.string().max(128),
	packet: Packet,
});
const MAX_WIRE_LENGTH = 512 * 1024;

export function createChannelRpc<
	Remote extends HostApi | NotebookApi,
	Local extends Partial<HostApi & NotebookApi>,
>(port: MessagePort, connectionId: string, role: 'host' | 'notebook', handlers: Local) {
	let listener: ((event: MessageEvent) => void) | undefined;
	const expectedResponse = role === 'host' ? ConnectedResult : QueryResult;
	const rpc = createBirpc<Remote, Local>(handlers, {
		timeout: REQUEST_TIMEOUT_MS,
		post: (packet: unknown) =>
			port.postMessage(JSON.stringify({ namespace: NAMESPACE, connectionId, packet })),
		on: (receive) => {
			listener = (event: MessageEvent) => {
				if (typeof event.data !== 'string' || event.data.length > MAX_WIRE_LENGTH) return;
				let raw: unknown;
				try {
					raw = JSON.parse(event.data);
				} catch {
					return;
				}
				const parsed = Envelope.safeParse(raw);
				if (!parsed.success || parsed.data.connectionId !== connectionId) return;
				const packet = parsed.data.packet;
				if (packet.t === 'q') {
					if (role === 'host') {
						if (packet.m === 'connected' || packet.a.length !== 1) return;
						const schema = packet.m === 'replaceQuery' ? QuerySnapshot : TitleSnapshot;
						const snapshot = schema.safeParse(packet.a[0]);
						if (!snapshot.success) return;
						packet.a = [snapshot.data];
					} else if (packet.m !== 'connected' || packet.a.length > 0) return;
				} else {
					const result = expectedResponse.safeParse(packet.r);
					if (!result.success) return;
					packet.r = result.data;
				}
				receive(packet);
			};
			port.addEventListener('message', listener);
			port.start();
		},
		off: () => {
			if (listener) port.removeEventListener('message', listener);
		},
	});
	return {
		rpc,
		dispose() {
			rpc.$close();
			port.close();
		},
	};
}
