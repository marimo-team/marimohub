import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { HostApi, NotebookApi } from './protocol';
import { REQUEST_TIMEOUT_MS } from './protocol';
import { wirePeer } from './testing-peer';
import { createChannelRpc } from './transport';

// birpc captures timer functions at import time.
vi.hoisted(() => vi.useFakeTimers());
afterAll(() => vi.useRealTimers());

const disposals: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

function fixture() {
	const ports = new MessageChannel();
	const handler = vi.fn<HostApi['replaceQuery']>(() => ({ applied: true }));
	const host = createChannelRpc<NotebookApi, HostApi>(ports.port1, 'connection-v1', 'host', {
		replaceQuery: handler,
		replaceTitle: vi.fn(() => ({ applied: true })),
	});
	disposals.push(() => {
		host.dispose();
		ports.port2.close();
	});
	return { host, peer: ports.port2, handler };
}

describe('frozen v1 wire peers', () => {
	it('accepts a historical request with additive fields and emits the v1 response', async () => {
		const { peer, handler } = fixture();
		const response = new Promise<string>((resolve) => {
			peer.onmessage = (event) => resolve(event.data);
		});
		peer.postMessage(
			'{"namespace":"marimohub.notebook-bridge","connectionId":"connection-v1","packet":{"t":"q","i":"request-1","m":"replaceQuery","a":[{"revision":1,"entries":[["tag","a"],["tag","b"]],"future":true}]},"future":true}',
		);
		expect(JSON.parse(await response)).toEqual({
			namespace: 'marimohub.notebook-bridge',
			connectionId: 'connection-v1',
			packet: { t: 's', i: 'request-1', r: { applied: true } },
		});
		expect(handler).toHaveBeenCalledWith({
			revision: 1,
			entries: [
				['tag', 'a'],
				['tag', 'b'],
			],
		});
	});
	it('reads the historical response layout and closes pending calls', async () => {
		const { host, peer } = fixture();
		peer.onmessage = (event) => {
			const request = JSON.parse(event.data) as { packet: { i: string; m: string } };
			expect(request.packet.m).toBe('connected');
			peer.postMessage(
				JSON.stringify({
					namespace: 'marimohub.notebook-bridge',
					connectionId: 'connection-v1',
					packet: { t: 's', i: request.packet.i, r: { ready: true, future: true } },
				}),
			);
		};
		await expect(host.rpc.connected()).resolves.toEqual({ ready: true });
		peer.onmessage = null;
		const pending = host.rpc.connected();
		const rejected = expect(pending).rejects.toThrow('closed');
		host.dispose();
		await rejected;
		host.dispose();
	});
	it('drops malformed packets, prototype methods, stale channels, and wrong-direction calls', async () => {
		const { peer, handler } = fixture();
		const send = (packet: unknown, connectionId = 'connection-v1') =>
			peer.postMessage(
				JSON.stringify({ namespace: 'marimohub.notebook-bridge', connectionId, packet }),
			);
		for (const value of [null, {}, 'garbage', 'x'.repeat(600_000)]) peer.postMessage(value);
		for (const method of ['__proto__', 'constructor', 'toString', 'connected', 'future'])
			send({ t: 'q', i: 'x', m: method, a: [] });
		send({ t: 'q', i: 'x', m: 'replaceQuery', a: [{ revision: 0, entries: [] }] }, 'old');
		send({ t: 'q', i: 'x', m: 'replaceQuery', a: [{ revision: 0, entries: [['a', 1]] }] });
		// A valid trailing request is a barrier on the ordered port.
		const barrier = new Promise<void>((resolve) => {
			peer.onmessage = () => resolve();
		});
		send({ t: 'q', i: 'barrier', m: 'replaceQuery', a: [{ revision: 2, entries: [] }] });
		await barrier;
		expect(handler).toHaveBeenCalledTimes(1);
	});
	it('accepts a frozen host and validates its query response', async () => {
		const ports = new MessageChannel();
		const connected = vi.fn(() => ({ ready: true as const }));
		const notebook = createChannelRpc<HostApi, NotebookApi>(
			ports.port1,
			'frozen-host',
			'notebook',
			{ connected },
		);
		disposals.push(() => {
			notebook.dispose();
			ports.port2.close();
		});
		const ready = new Promise<unknown>((resolve) => {
			ports.port2.onmessage = (event) => resolve(JSON.parse(event.data));
		});
		ports.port2.postMessage(
			'{"namespace":"marimohub.notebook-bridge","connectionId":"frozen-host","packet":{"t":"q","i":"connect","m":"connected","a":[]}}',
		);
		await expect(ready).resolves.toEqual({
			namespace: 'marimohub.notebook-bridge',
			connectionId: 'frozen-host',
			packet: { t: 's', i: 'connect', r: { ready: true } },
		});
		expect(connected).toHaveBeenCalledOnce();
		ports.port2.onmessage = (event) => {
			const request = JSON.parse(event.data) as { packet: { i: string; m: string; a: unknown[] } };
			expect(request.packet.m).toBe('replaceQuery');
			expect(request.packet.a).toEqual([{ revision: 1, entries: [['empty', '']] }]);
			ports.port2.postMessage(
				JSON.stringify({
					namespace: 'marimohub.notebook-bridge',
					connectionId: 'frozen-host',
					packet: { t: 's', i: request.packet.i, r: { applied: true, future: 'ignored' } },
				}),
			);
		};
		await expect(
			notebook.rpc.replaceQuery({ revision: 1, entries: [['empty', '']] }),
		).resolves.toEqual({ applied: true });
	});
	it('times out requests when responses are malformed', async () => {
		const { host, peer } = fixture();
		const remote = wirePeer(peer, 'connection-v1');
		disposals.push(remote.dispose);
		const settled = vi.fn();
		const pending = host.rpc.connected();
		void pending.then(settled, settled);
		const rejected = expect(pending).rejects.toThrow('timeout');
		remote.reply(await remote.nextRequest(), { ready: false });
		const barrier = host.rpc.connected();
		remote.reply(await remote.nextRequest(), { ready: true });
		await barrier;
		await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
	});
	it('cannot settle a request with a mismatched ID, stale connection or malformed response', async () => {
		const { host, peer: port } = fixture();
		const remote = wirePeer(port, 'connection-v1');
		disposals.push(remote.dispose);
		const settled = vi.fn();
		const first = host.rpc.connected().then(settled);
		const request = await remote.nextRequest();
		remote.send({ t: 's', i: 'unknown', r: { ready: true } });
		remote.reply(request, { ready: false });
		port.postMessage(
			JSON.stringify({
				namespace: 'marimohub.notebook-bridge',
				connectionId: 'previous',
				packet: { t: 's', i: request.i, r: { ready: true } },
			}),
		);
		const barrier = host.rpc.connected();
		remote.reply(await remote.nextRequest(), { ready: true });
		await barrier;
		expect(settled).not.toHaveBeenCalled();
		remote.reply(request, { ready: true });
		await first;
		expect(settled).toHaveBeenCalledExactlyOnceWith({ ready: true });
	});
	it('rejects all concurrent pending calls when disposed and never allows a later call', async () => {
		const { host } = fixture();
		const results = Promise.allSettled(Array.from({ length: 20 }, () => host.rpc.connected()));
		host.dispose();
		for (const result of await results) {
			expect(result.status).toBe('rejected');
			if (result.status === 'rejected') expect(String(result.reason)).toContain('closed');
		}
		await expect(host.rpc.connected()).rejects.toThrow('closed');
	});
});
