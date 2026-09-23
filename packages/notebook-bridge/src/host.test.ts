import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { wirePeer } from './testing-peer';
import { createHostBridge } from './host';
import { HANDSHAKE_TIMEOUT_MS, NAMESPACE } from './protocol';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function fixture() {
	const parent = new EventTarget();
	Object.assign(parent, { crypto: globalThis.crypto });
	const frame = new EventTarget();
	const peer = { postMessage: vi.fn() };
	Object.assign(frame, { ownerDocument: { defaultView: parent }, contentWindow: peer });
	const onQuery = vi.fn(() => true);
	const onStatus = vi.fn();
	const onTitle = vi.fn(() => true);
	const bridge = createHostBridge({
		iframe: frame as HTMLIFrameElement,
		origin: 'https://notebook.example',
		excludedKeys: ['provider'],
		onQuery,
		onTitle,
		onStatus,
	});
	cleanups.push(() => bridge.dispose());
	const ready = (overrides = {}, origin = 'https://notebook.example', source: unknown = peer) => {
		const event = new Event('message');
		Object.assign(event, {
			origin,
			source,
			data: {
				namespace: NAMESPACE,
				kind: 'ready',
				documentId: 'frozen-document',
				version: { major: 1, minor: 7 },
				capabilities: ['query-params.v1', 'optional.future'],
				future: true,
				...overrides,
			},
		});
		parent.dispatchEvent(event);
	};
	const negotiate = async (documentId = 'frozen-document', capabilities = ['query-params.v1']) => {
		const connected = new Promise<void>((resolve) => {
			onStatus.mockImplementation((status) => {
				if (status === 'connected') resolve();
			});
		});
		ready({ documentId, capabilities });
		const [connect, , ports] = peer.postMessage.mock.calls.at(-1)!;
		const port = ports[0] as MessagePort;
		cleanups.push(() => port.close());
		const remote = wirePeer(port, connect.connectionId);
		cleanups.push(remote.dispose);
		const request = await remote.nextRequest();
		remote.reply(request, { ready: true });
		await connected;
		return remote;
	};
	return { parent, frame, peer, bridge, ready, onQuery, onTitle, onStatus, negotiate };
}

describe('host lifecycle and frozen v1 peer', () => {
	it('negotiates titles separately and rejects stale or excessive updates', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { negotiate, onTitle, onQuery } = fixture();
		const remote = await negotiate('titles', ['query-params.v1', 'document-title.v1']);
		await expect(remote.call('replaceTitle', { revision: 1, title: 'Live' })).resolves.toEqual({
			applied: true,
		});
		await expect(remote.call('replaceTitle', { revision: 2, title: 'Too soon' })).resolves.toEqual({
			applied: false,
		});
		vi.setSystemTime(Date.now() + 100);
		await expect(remote.call('replaceTitle', { revision: 1, title: 'Stale' })).resolves.toEqual({
			applied: false,
		});
		await expect(remote.call('replaceTitle', { revision: 3, title: '' })).resolves.toEqual({
			applied: true,
		});
		expect(onTitle.mock.calls).toEqual([['Live'], ['']]);
		expect(onQuery).not.toHaveBeenCalled();
	});
	it('applies title and query updates within the same rate-limit window', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { negotiate, onTitle, onQuery } = fixture();
		const remote = await negotiate('titles', ['query-params.v1', 'document-title.v1']);
		await expect(remote.call('replaceTitle', { revision: 1, title: 'Live' })).resolves.toEqual({
			applied: true,
		});
		await expect(
			remote.call('replaceQuery', { revision: 1, entries: [['id', 'one']] }),
		).resolves.toEqual({ applied: true });
		expect(onTitle).toHaveBeenCalledExactlyOnceWith('Live');
		expect(onQuery).toHaveBeenCalledExactlyOnceWith({ revision: 1, entries: [['id', 'one']] });
	});
	it('ignores title requests without a negotiated capability', async () => {
		const { negotiate, onTitle } = fixture();
		const remote = await negotiate();
		await expect(remote.call('replaceTitle', { revision: 1, title: 'Ignored' })).resolves.toEqual({
			applied: false,
		});
		expect(onTitle).not.toHaveBeenCalled();
	});

	it('rejects spoofed windows and origins before creating a channel', () => {
		const { ready, peer, bridge } = fixture();
		ready({}, 'https://evil.example');
		ready({}, 'https://notebook.example', {});
		ready({ documentId: 1 });
		expect(peer.postMessage).toHaveBeenCalledTimes(1);
		expect(bridge.status).toBe('connecting');
	});
	it.each([{ version: { major: 2, minor: 0 } }, { capabilities: ['future.v2'] }])(
		'disables incompatible peers without RPC: %o',
		(overrides) => {
			const { ready, peer, bridge } = fixture();
			ready(overrides);
			expect(bridge.status).toBe('unavailable');
			expect(peer.postMessage).toHaveBeenCalledTimes(1);
		},
	);
	it('bounds retries and restarts only on a new iframe load', () => {
		vi.useFakeTimers();
		const { frame, peer, bridge } = fixture();
		vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
		expect(bridge.status).toBe('unavailable');
		const count = peer.postMessage.mock.calls.length;
		expect(count).toBeLessThan(16);
		vi.advanceTimersByTime(30_000);
		expect(peer.postMessage).toHaveBeenCalledTimes(count);
		frame.dispatchEvent(new Event('load'));
		expect(bridge.status).toBe('connecting');
		bridge.dispose();
		bridge.dispose();
		frame.dispatchEvent(new Event('load'));
		vi.advanceTimersByTime(30_000);
		expect(bridge.status).toBe('disposed');
		expect(vi.getTimerCount()).toBe(0);
	});
	it('negotiates additive fields, filters provider keys and ignores stale revisions and disposed channels', async () => {
		const { ready, peer, bridge, onQuery, onStatus } = fixture();
		const connected = new Promise<void>((resolve) => {
			onStatus.mockImplementation((status) => {
				if (status === 'connected') resolve();
			});
		});
		ready();
		const [connect, origin, ports] = peer.postMessage.mock.calls.at(-1)!;
		expect(origin).toBe('https://notebook.example');
		expect(connect.excludedKeys).toEqual(['provider']);
		const port = ports[0] as MessagePort;
		cleanups.push(() => port.close());
		let response: ((value: unknown) => void) | undefined;
		const send = (packet: unknown) =>
			port.postMessage(
				JSON.stringify({ namespace: NAMESPACE, connectionId: connect.connectionId, packet }),
			);
		port.onmessage = (event) => {
			const { packet } = JSON.parse(event.data) as {
				packet: { t: string; i: string; r?: unknown };
			};
			if (packet.t === 'q') send({ t: 's', i: packet.i, r: { ready: true, optional: true } });
			else response?.(packet.r);
		};
		await connected;
		const update = (revision: number) =>
			new Promise<unknown>((resolve) => {
				response = resolve;
				send({
					t: 'q',
					i: String(revision),
					m: 'replaceQuery',
					a: [
						{
							revision,
							entries: [
								['tag', 'one'],
								['tag', 'two'],
								['provider', 'secret'],
								['access_token', 'secret'],
							],
						},
					],
				});
			});
		await expect(update(2)).resolves.toEqual({ applied: true });
		expect(onQuery).toHaveBeenCalledWith({
			revision: 2,
			entries: [
				['tag', 'one'],
				['tag', 'two'],
			],
		});
		await expect(update(1)).resolves.toEqual({ applied: false });
		expect(onQuery).toHaveBeenCalledTimes(1);
		bridge.dispose();
		send({ t: 'q', i: 'late', m: 'replaceQuery', a: [{ revision: 100, entries: [] }] });
		expect(onQuery).toHaveBeenCalledTimes(1);
	});
	it('enforces the rate boundary and suppresses equal filtered snapshots, including clear', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { negotiate, onQuery } = fixture();
		const remote = await negotiate();
		const send = (revision: number, entries: [string, string][]) =>
			remote.call('replaceQuery', { revision, entries });
		await expect(send(1, [['id', 'one']])).resolves.toEqual({ applied: true });
		vi.setSystemTime(Date.now() + 99);
		await expect(send(2, [['id', 'two']])).resolves.toEqual({ applied: false });
		vi.setSystemTime(Date.now() + 1);
		await expect(send(3, [['id', 'two']])).resolves.toEqual({ applied: true });
		vi.setSystemTime(Date.now() + 100);
		await expect(
			send(4, [
				['id', 'two'],
				['provider', 'secret'],
			]),
		).resolves.toEqual({ applied: true });
		expect(onQuery).toHaveBeenCalledTimes(2);
		await expect(send(5, [])).resolves.toEqual({ applied: true });
		vi.setSystemTime(Date.now() + 100);
		await expect(send(6, [])).resolves.toEqual({ applied: true });
		expect(onQuery).toHaveBeenCalledTimes(3);
		expect(onQuery).toHaveBeenLastCalledWith({ revision: 5, entries: [] });
	});
	it('does not cache snapshots that the router refuses', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { negotiate, onQuery } = fixture();
		onQuery.mockReturnValueOnce(false);
		const remote = await negotiate();
		await expect(
			remote.call('replaceQuery', { revision: 1, entries: [['id', 'one']] }),
		).resolves.toEqual({ applied: false });
		vi.setSystemTime(Date.now() + 100);
		await expect(
			remote.call('replaceQuery', { revision: 2, entries: [['id', 'one']] }),
		).resolves.toEqual({ applied: true });
		expect(onQuery).toHaveBeenCalledTimes(2);
	});
	it('does not cache titles that the router refuses', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { negotiate, onTitle } = fixture();
		onTitle.mockReturnValueOnce(false);
		const remote = await negotiate('titles', ['query-params.v1', 'document-title.v1']);
		await expect(remote.call('replaceTitle', { revision: 1, title: 'Live' })).resolves.toEqual({
			applied: false,
		});
		vi.setSystemTime(Date.now() + 100);
		await expect(remote.call('replaceTitle', { revision: 2, title: 'Live' })).resolves.toEqual({
			applied: true,
		});
		expect(onTitle.mock.calls).toEqual([['Live'], ['Live']]);
	});
	it('resets revisions and snapshot equality after a new document loads', async () => {
		const { negotiate, onQuery, frame } = fixture();
		const first = await negotiate();
		await expect(
			first.call('replaceQuery', { revision: 100, entries: [['id', 'one']] }),
		).resolves.toEqual({ applied: true });
		frame.dispatchEvent(new Event('load'));
		const second = await negotiate('new-document');
		first.send({
			t: 'q',
			i: 'late',
			m: 'replaceQuery',
			a: [{ revision: 101, entries: [['id', 'stale']] }],
		});
		await expect(
			second.call('replaceQuery', { revision: 1, entries: [['id', 'one']] }),
		).resolves.toEqual({ applied: true });
		expect(onQuery).toHaveBeenCalledTimes(2);
		expect(onQuery).toHaveBeenLastCalledWith({ revision: 1, entries: [['id', 'one']] });
	});
	it('ignores a queued handshake acknowledgement after a document replacement', async () => {
		const NativeMessageChannel = globalThis.MessageChannel;
		const channels: MessageChannel[] = [];
		vi.stubGlobal(
			'MessageChannel',
			class extends NativeMessageChannel {
				constructor() {
					super();
					channels.push(this);
				}
			},
		);
		const { ready, peer, frame, bridge, onStatus } = fixture();
		ready();
		const [connect, , ports] = peer.postMessage.mock.calls.at(-1)!;
		const port = ports[0] as MessagePort;
		const old = wirePeer(port, connect.connectionId);
		cleanups.push(old.dispose);
		const pending = await old.nextRequest();
		const replaced = new Promise<ReturnType<typeof wirePeer>>((resolve) => {
			// Run after RPC receives the reply, before its promise continuation can connect.
			channels[0].port1.addEventListener(
				'message',
				() => {
					frame.dispatchEvent(new Event('load'));
					ready({ documentId: 'next-document' });
					const [next, , nextPorts] = peer.postMessage.mock.calls.at(-1)!;
					const replacement = wirePeer(nextPorts[0], next.connectionId);
					cleanups.push(replacement.dispose);
					resolve(replacement);
				},
				{ once: true },
			);
		});
		old.reply(pending, { ready: true });
		const replacement = await replaced;
		const acknowledgement = await replacement.nextRequest();
		expect(bridge.status).toBe('connecting');
		expect(onStatus).not.toHaveBeenCalledWith('connected');
		replacement.reply(acknowledgement, { ready: true });
		await vi.waitFor(() => expect(bridge.status).toBe('connected'));
		expect(peer.postMessage.mock.calls.filter(([data]) => data.kind === 'connect')).toHaveLength(2);
	});
	it('does not open another channel for repeated ready messages', async () => {
		const { ready, peer, negotiate } = fixture();
		await negotiate();
		ready();
		ready({ documentId: 'unsolicited-document' });
		expect(peer.postMessage.mock.calls.filter(([data]) => data.kind === 'connect')).toHaveLength(1);
	});

	it('closes an untransferred port and disables the connection when transfer fails', () => {
		const { ready, peer, bridge } = fixture();
		let close: MockInstance<() => void> | undefined;
		peer.postMessage.mockImplementation((data, _origin, ports) => {
			if (data.kind !== 'connect') return;
			close = vi.spyOn(ports[0] as MessagePort, 'close');
			throw new DOMException('Transfer failed', 'DataCloneError');
		});
		ready();
		expect(bridge.status).toBe('unavailable');
		expect(close).toHaveBeenCalledOnce();
	});
});
