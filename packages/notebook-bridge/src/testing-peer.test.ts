import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wirePeer } from './testing-peer';

const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

function fixture() {
	const ports = new MessageChannel();
	const peer = wirePeer(ports.port1, 'test', 100);
	const remote = wirePeer(ports.port2, 'test', 100);
	cleanups.push(peer.dispose, remote.dispose);
	return { peer, remote, port: ports.port1 };
}

describe('wire peer failure handling', () => {
	it('times out unanswered calls and missing requests without leaving timers', async () => {
		const { peer } = fixture();
		const call = expect(peer.call('connected')).rejects.toThrow('timed out waiting for connected');
		const request = expect(peer.nextRequest()).rejects.toThrow('timed out waiting for a request');
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all([call, request]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('rejects pending and future operations on idempotent disposal', async () => {
		const { peer } = fixture();
		const pending = Promise.allSettled([
			peer.call('first'),
			peer.call('second'),
			peer.nextRequest(),
		]);
		peer.dispose();
		peer.dispose();
		for (const result of await pending) {
			expect(result.status).toBe('rejected');
			if (result.status === 'rejected') expect(String(result.reason)).toContain('disposed');
		}
		await expect(peer.call('later')).rejects.toThrow('disposed');
		await expect(peer.nextRequest()).rejects.toThrow('disposed');
		expect(vi.getTimerCount()).toBe(0);
	});
	it('cancels deadlines when a request and response arrive', async () => {
		const { peer, remote } = fixture();
		const received = remote.nextRequest();
		const result = peer.call('connected');
		remote.reply(await received, { ready: true });
		await expect(result).resolves.toEqual({ ready: true });
		expect(vi.getTimerCount()).toBe(0);
	});
	it('rejects immediately and clears the deadline when sending fails', async () => {
		const { peer, port } = fixture();
		vi.spyOn(port, 'postMessage').mockImplementation(() => {
			throw new Error('send failed');
		});
		await expect(peer.call('connected')).rejects.toThrow('send failed');
		expect(vi.getTimerCount()).toBe(0);
	});
});
