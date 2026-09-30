import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { wirePeer } from './testing-peer';
import { createHostBridge } from './host';
import type { AppNavigation } from './protocol';
import { HANDSHAKE_TIMEOUT_MS, NAMESPACE } from './protocol';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function fixture(navigation = false, peerNavigation = navigation) {
	const parent = new EventTarget();
	Object.assign(parent, { crypto: globalThis.crypto });
	const frame = new EventTarget();
	const peer = { postMessage: vi.fn() };
	Object.assign(frame, { ownerDocument: { defaultView: parent }, contentWindow: peer });
	const onQuery = vi.fn(() => true);
	const onStatus = vi.fn();
	const onNavigateApp = vi.fn<(destination: AppNavigation) => boolean>(() => true);
	const bridge = createHostBridge({
		iframe: frame as HTMLIFrameElement,
		origin: 'https://notebook.example',
		excludedKeys: ['provider'],
		onQuery,
		onStatus,
		...(navigation ? { appBaseUrl: 'https://hub.example/prefix/app/', onNavigateApp } : {}),
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
				capabilities: [
					'query-params.v1',
					'optional.future',
					...(peerNavigation ? ['app-navigation.v1'] : []),
				],
				future: true,
				...overrides,
			},
		});
		parent.dispatchEvent(event);
	};
	const negotiate = async (documentId = 'frozen-document') => {
		const connected = new Promise<void>((resolve) => {
			onStatus.mockImplementation((status) => {
				if (status === 'connected') resolve();
			});
		});
		ready({ documentId });
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
	return { parent, frame, peer, bridge, ready, onQuery, onStatus, onNavigateApp, negotiate };
}

describe('host lifecycle and frozen v1 peer', () => {
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

describe('app navigation', () => {
	it('filters credentials and fences old queries and repeated navigation', async () => {
		const { negotiate, onNavigateApp, onQuery, peer } = fixture(true);
		const remote = await negotiate();
		expect(peer.postMessage.mock.calls.at(-1)![0]).toMatchObject({
			appBaseUrl: 'https://hub.example/prefix/app/',
			capabilities: ['query-params.v1', 'app-navigation.v1'],
		});
		const destination = {
			slug: 'team/match',
			entries: [
				['id', 'xyz'],
				['provider', 'secret'],
				['access_token', 'secret'],
				['file', 'notebook.py'],
			],
			hash: '#result',
		};
		await expect(remote.call('navigateApp', destination)).resolves.toEqual({ applied: true });
		expect(onNavigateApp).toHaveBeenCalledExactlyOnceWith({
			slug: 'team/match',
			entries: [['id', 'xyz']],
			hash: '#result',
		});
		await expect(
			remote.call('replaceQuery', { revision: 1, entries: [['old', 'value']] }),
		).resolves.toEqual({ applied: false });
		await expect(remote.call('navigateApp', destination)).resolves.toEqual({ applied: false });
		expect(onQuery).not.toHaveBeenCalled();
	});
	it.each([
		[false, false],
		[true, false],
		[false, true],
	])(
		'does not enable navigation unless both sides opt in (host: %s, notebook: %s)',
		async (enabled, peerEnabled) => {
			const { negotiate, onNavigateApp, peer } = fixture(enabled, peerEnabled);
			const remote = await negotiate();
			expect(peer.postMessage.mock.calls.at(-1)![0]).not.toHaveProperty('appBaseUrl');
			await expect(
				remote.call('navigateApp', { slug: 'match', entries: [], hash: '' }),
			).resolves.toEqual({ applied: false });
			expect(onNavigateApp).not.toHaveBeenCalled();
		},
	);
	it('rejects malformed destinations before dispatch and resumes after a declined navigation', async () => {
		const { negotiate, onNavigateApp, onQuery } = fixture(true);
		const remote = await negotiate();
		for (const slug of ['../admin', '//evil.example', 'match?next=evil', '%2e%2e', 'match\\evil']) {
			remote.send({ t: 'q', i: slug, m: 'navigateApp', a: [{ slug, entries: [], hash: '' }] });
		}
		await remote.call('replaceQuery', { revision: 1, entries: [] });
		expect(onNavigateApp).not.toHaveBeenCalled();
		onNavigateApp.mockReturnValueOnce(false);
		await expect(
			remote.call('navigateApp', { slug: 'match', entries: [], hash: '' }),
		).resolves.toEqual({ applied: false });
		await expect(
			remote.call('navigateApp', { slug: 'match', entries: [], hash: '' }),
		).resolves.toEqual({ applied: true });
		expect(onQuery).toHaveBeenCalledOnce();
	});
});

it('resumes queries after the navigation callback throws and permits another click', async () => {
	const { negotiate, onNavigateApp, onQuery } = fixture(true);
	const remote = await negotiate();
	onNavigateApp.mockImplementationOnce(() => {
		throw new Error('Router unavailable');
	});
	const destination = { slug: 'match', entries: [], hash: '' };
	await expect(remote.call('navigateApp', destination)).resolves.toEqual({ applied: false });
	await expect(
		remote.call('replaceQuery', { revision: 1, entries: [['id', 'retained']] }),
	).resolves.toEqual({ applied: true });
	expect(onQuery).toHaveBeenCalledExactlyOnceWith({ revision: 1, entries: [['id', 'retained']] });
	await expect(remote.call('navigateApp', destination)).resolves.toEqual({ applied: true });
	expect(onNavigateApp).toHaveBeenCalledTimes(2);
});

it('rejects navigation before the handshake completes', async () => {
	const { ready, peer, onNavigateApp } = fixture(true);
	ready();
	const [connect, , ports] = peer.postMessage.mock.calls.at(-1)!;
	const remote = wirePeer(ports[0], connect.connectionId);
	cleanups.push(remote.dispose);
	await remote.nextRequest();
	await expect(
		remote.call('navigateApp', { slug: 'match', entries: [], hash: '' }),
	).resolves.toEqual({ applied: false });
	expect(onNavigateApp).not.toHaveBeenCalled();
});

it('rejects queued navigation from an old document and resets the fence on reload', async () => {
	const { negotiate, frame, onNavigateApp, onQuery } = fixture(true);
	const old = await negotiate();
	const destination = { slug: 'match', entries: [], hash: '' };
	await old.call('navigateApp', destination);
	old.send({ t: 'q', i: 'queued', m: 'navigateApp', a: [{ ...destination, slug: 'stale' }] });
	frame.dispatchEvent(new Event('load'));
	const current = await negotiate('new-document');
	await expect(current.call('replaceQuery', { revision: 0, entries: [] })).resolves.toEqual({
		applied: true,
	});
	await expect(current.call('navigateApp', destination)).resolves.toEqual({ applied: true });
	expect(onNavigateApp.mock.calls.map(([value]) => value.slug)).toEqual(['match', 'match']);
	expect(onQuery).toHaveBeenCalledOnce();
});

it('drops invalid navigation arguments before invoking the host', async () => {
	const { negotiate, onNavigateApp } = fixture(true);
	const remote = await negotiate();
	const valid = { slug: 'match', entries: [], hash: '' };
	for (const value of [
		null,
		{},
		{ ...valid, slug: 'a'.repeat(64) },
		{ ...valid, entries: [['id', 123]] },
		{ ...valid, entries: [['id']] },
		{ ...valid, entries: Array.from({ length: 257 }, () => ['id', 'x']) },
		{ ...valid, entries: [['id', 'é'.repeat(11000)]] },
		{ ...valid, hash: 'https://evil.example' },
		{ ...valid, hash: '#bad\n' },
		{ ...valid, hash: `#${'x'.repeat(8192)}` },
	])
		remote.send({ t: 'q', i: 'invalid', m: 'navigateApp', a: [value] });
	remote.send({ t: 'q', i: 'extra', m: 'navigateApp', a: [valid, valid] });
	await remote.call('replaceQuery', { revision: 1, entries: [] });
	expect(onNavigateApp).not.toHaveBeenCalled();
	await expect(remote.call('navigateApp', valid)).resolves.toEqual({ applied: true });
});
