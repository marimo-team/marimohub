import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNotebookBridge } from './notebook';
import { wirePeer } from './testing-peer';
import { NAMESPACE } from './protocol';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function fixture() {
	let onMutation: () => void;
	vi.stubGlobal(
		'MutationObserver',
		class {
			constructor(callback: () => void) {
				onMutation = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	const win = new EventTarget();
	const parent = { postMessage: vi.fn() };
	const location = { search: '?early=1' };
	const history = { pushState: vi.fn(), replaceState: vi.fn() };
	const document = { head: {}, title: 'Notebook' };
	const changeTitle = (title: string) => {
		document.title = title;
		onMutation();
	};
	Object.assign(win, {
		parent,
		history,
		crypto: globalThis.crypto,
		location,
		document,
	});
	const options = { window: win as unknown as Window, parentOrigin: 'https://hub.example' };
	const bridge = startNotebookBridge(options);
	cleanups.push(() => bridge.dispose());
	const connect = (overrides = {}, origin = 'https://hub.example', source: unknown = parent) => {
		const ports = new MessageChannel();
		cleanups.push(() => {
			ports.port1.close();
			ports.port2.close();
		});
		const close = vi.spyOn(ports.port1, 'close');
		const documentId = parent.postMessage.mock.calls[0][0].documentId;
		const event = new Event('message');
		Object.assign(event, {
			origin,
			source,
			ports: [ports.port1],
			data: {
				namespace: NAMESPACE,
				kind: 'connect',
				documentId,
				connectionId: 'fresh',
				excludedKeys: [],
				version: { major: 1, minor: 0 },
				capabilities: ['query-params.v1'],
				...overrides,
			},
		});
		win.dispatchEvent(event);
		return { close, peer: ports.port2 };
	};
	const change = (search: string) => {
		location.search = search;
		win.dispatchEvent(new Event('popstate'));
	};
	const negotiate = async (connectionId = 'fresh', titles = false) => {
		const { peer: port } = connect({
			connectionId,
			excludedKeys: ['provider'],
			capabilities: ['query-params.v1', ...(titles ? ['document-title.v1'] : [])],
		});
		const peer = wirePeer(port, connectionId);
		cleanups.push(peer.dispose);
		await expect(peer.call('connected')).resolves.toEqual({ ready: true });
		return peer;
	};
	return { win, bridge, options, history, connect, change, changeTitle, negotiate };
}

describe('notebook observer lifecycle', () => {
	it('keeps the initial title local until it changes, including after reconnect', async () => {
		vi.useFakeTimers();
		const { negotiate, changeTitle } = fixture();
		for (const connectionId of ['fresh', 'replacement']) {
			const peer = await negotiate(connectionId, true);
			await vi.advanceTimersByTimeAsync(100);
			const query = await peer.nextRequest();
			expect(query.m).toBe('replaceQuery');
			peer.reply(query, { applied: true });
			await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
			changeTitle('Notebook');
			await vi.advanceTimersByTimeAsync(200);
			expect(peer.requests).toHaveLength(0);
			if (connectionId === 'fresh') continue;
			changeTitle('Live forecast');
			await vi.advanceTimersByTimeAsync(100);
			const title = await peer.nextRequest();
			expect(title.m).toBe('replaceTitle');
			expect(title.a).toEqual([{ revision: 3, title: 'Live forecast' }]);
			peer.reply(title, { applied: true });
			await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
			changeTitle('Notebook');
			await vi.advanceTimersByTimeAsync(100);
			expect((await peer.nextRequest()).a).toEqual([{ revision: 4, title: 'Notebook' }]);
		}
	});
	it('retains title changes before negotiation and across reconnects', async () => {
		vi.useFakeTimers();
		const { negotiate, changeTitle } = fixture();
		changeTitle('Early change');
		for (const connectionId of ['fresh', 'replacement']) {
			const peer = await negotiate(connectionId, true);
			await vi.advanceTimersByTimeAsync(100);
			const query = await peer.nextRequest();
			const title = await peer.nextRequest();
			expect(query.m).toBe('replaceQuery');
			expect(title.m).toBe('replaceTitle');
			expect(title.a[0]).toMatchObject({ title: 'Early change' });
			peer.reply(query, { applied: true });
			peer.reply(title, { applied: true });
			await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
		}
	});

	it('installs once and preserves later History wrappers on disposal', () => {
		const { bridge, options, history } = fixture();
		expect(startNotebookBridge(options)).toBe(bridge);
		const replacement = vi.fn();
		history.pushState = replacement;
		bridge.dispose();
		bridge.dispose();
		expect(history.pushState).toBe(replacement);
		expect(bridge.status).toBe('disposed');
	});
	it('rejects stale document IDs and incompatible majors', () => {
		const { bridge, connect } = fixture();
		expect(connect({ documentId: 'previous' }).close).toHaveBeenCalledOnce();
		expect(connect({ version: { major: 2, minor: 0 } }).close).toHaveBeenCalledOnce();
		expect(bridge.status).toBe('connecting');
	});
	it('rejects unexpected parent windows and origins', () => {
		const { bridge, connect } = fixture();
		connect({}, 'https://evil.example');
		connect({}, 'https://hub.example', {});
		expect(bridge.status).toBe('connecting');
	});
	it('bounds incomplete negotiation and rejects connection replay', () => {
		vi.useFakeTimers();
		const { bridge, connect } = fixture();
		connect();
		expect(connect().close).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(10_000);
		expect(bridge.status).toBe('unavailable');
		bridge.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it('coalesces updates while a request is pending and sends only the latest snapshot', async () => {
		vi.useFakeTimers();
		const { negotiate, change } = fixture();
		const peer = await negotiate();
		await vi.advanceTimersByTimeAsync(100);
		const first = await peer.nextRequest();
		expect(first.a).toEqual([{ revision: 1, entries: [['early', '1']] }]);
		change('?discard=1');
		change('?tag=one&tag=two&empty=&provider=secret&access_token=secret');
		await vi.advanceTimersByTimeAsync(1000);
		expect(peer.requests).toHaveLength(0);
		peer.reply(first, { applied: true });
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		const latest = await peer.nextRequest();
		expect(latest.a).toEqual([
			{
				revision: 2,
				entries: [
					['tag', 'one'],
					['tag', 'two'],
					['empty', ''],
				],
			},
		]);
		peer.reply(latest, { applied: true });
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
		change('?tag=one&tag=two&empty=&provider=changed');
		await vi.advanceTimersByTimeAsync(1000);
		expect(peer.requests).toHaveLength(0);
	});
	it('retries an unaccepted snapshot with a newer revision', async () => {
		vi.useFakeTimers();
		const { negotiate } = fixture();
		const peer = await negotiate();
		await vi.advanceTimersByTimeAsync(100);
		const first = await peer.nextRequest();
		peer.reply(first, { applied: false });
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		const retry = await peer.nextRequest();
		expect(retry.a).toEqual([{ revision: 2, entries: [['early', '1']] }]);
	});
	it('ignores acknowledgements from a replaced connection with an update outstanding', async () => {
		vi.useFakeTimers();
		const { negotiate, change, bridge } = fixture();
		const old = await negotiate();
		await vi.advanceTimersByTimeAsync(100);
		const outstanding = await old.nextRequest();
		change('?new=1');
		const current = await negotiate('replacement');
		old.reply(outstanding, { applied: true });
		await vi.advanceTimersByTimeAsync(100);
		const latest = await current.nextRequest();
		expect(latest.a).toEqual([{ revision: 2, entries: [['new', '1']] }]);
		expect(bridge.status).toBe('connected');
	});
	it('cancels an in-flight update without resurrecting timers or status', async () => {
		vi.useFakeTimers();
		const { negotiate, bridge, change } = fixture();
		const peer = await negotiate();
		await vi.advanceTimersByTimeAsync(100);
		const pending = await peer.nextRequest();
		bridge.dispose();
		peer.reply(pending, { applied: true });
		change('?late=1');
		await vi.advanceTimersByTimeAsync(20_000);
		expect(bridge.status).toBe('disposed');
		expect(vi.getTimerCount()).toBe(0);
		expect(peer.requests).toHaveLength(0);
	});
	it('recovers from an oversized snapshot and sends a subsequent clear', async () => {
		vi.useFakeTimers();
		const { negotiate, change } = fixture();
		change(`?large=${'x'.repeat(70_000)}`);
		const peer = await negotiate();
		await vi.advanceTimersByTimeAsync(1000);
		expect(peer.requests).toHaveLength(0);
		change('');
		await vi.advanceTimersByTimeAsync(100);
		const cleared = await peer.nextRequest();
		expect(cleared.a).toEqual([{ revision: 2, entries: [] }]);
	});
	it('accepts a fresh host after the initial readiness window expires', async () => {
		vi.useFakeTimers();
		const { negotiate, bridge, change } = fixture();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(bridge.status).toBe('unavailable');
		change('?late-host=ready');
		const peer = await negotiate();
		await vi.advanceTimersByTimeAsync(100);
		expect((await peer.nextRequest()).a).toEqual([
			{ revision: 1, entries: [['late-host', 'ready']] },
		]);
		expect(bridge.status).toBe('connected');
	});
	it('allows a new observer after disposal with a new document identifier', () => {
		const { bridge, options, win } = fixture();
		const parent = (win as unknown as Window).parent;
		const posts = vi.mocked(parent.postMessage);
		const first = posts.mock.calls[0][0] as { documentId: string };
		bridge.dispose();
		const next = startNotebookBridge(options);
		cleanups.push(() => next.dispose());
		const last = posts.mock.calls.at(-1)![0] as { documentId: string };
		expect(last.documentId).not.toBe(first.documentId);
		expect(next).not.toBe(bridge);
	});
});
