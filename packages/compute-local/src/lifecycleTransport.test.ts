import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requestLifecycle } from './lifecycleTransport';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
});

async function fixture(handler?: (socket: Socket) => void) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'capture-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	await writeFile(path.join(directory, 'capability.json'), '{"supported":true,"protocol":1}');
	if (handler) {
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
			handler(socket);
		});
		await new Promise<void>((resolve) =>
			server.listen(path.join(directory, 'control.sock'), resolve),
		);
		cleanups.push(() => {
			for (const socket of sockets) socket.destroy();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});
	}
	return directory;
}

it('falls back before dispatch when the supervisor is absent', async () => {
	expect(await requestLifecycle(await fixture(), { action: 'status' })).toBeUndefined();
});

it('exchanges a fragmented response without a process launch', async () => {
	const directory = await fixture((socket) =>
		socket.once('data', (data) => {
			expect(JSON.parse(data.toString())).toEqual({ action: 'status' });
			socket.write('{"ok":');
			socket.end('true}\n');
		}),
	);
	expect(await requestLifecycle(directory, { action: 'status' })).toBe('{"ok":true}');
});

it('rejects a disconnected mutation without permitting replay', async () => {
	const directory = await fixture((socket) => socket.once('data', () => socket.end()));
	await expect(requestLifecycle(directory, { action: 'prepare' })).rejects.toThrow(
		'CAPTURE_UNAVAILABLE',
	);
});

it('bounds stalled requests', async () => {
	const directory = await fixture((socket) => socket.resume());
	await expect(requestLifecycle(directory, { action: 'status' }, 20)).rejects.toThrow(
		'CAPTURE_UNAVAILABLE',
	);
});

it('bounds response bytes', async () => {
	const directory = await fixture((socket) => {
		socket.on('error', () => {});
		socket.once('data', () => socket.end(Buffer.alloc(1024 * 1024 + 1)));
	});
	await expect(requestLifecycle(directory, { action: 'status' })).rejects.toThrow(
		'CAPTURE_UNAVAILABLE',
	);
});

it.each([
	'null',
	'{}',
	'{',
	'[]',
	'{"supported":false,"protocol":1}',
	'{"supported":true,"protocol":2}',
])('falls back without opening a socket for capability %s', async (capability) => {
	const connected = vi.fn((socket: Socket) => socket.end());
	const directory = await fixture(connected);
	await writeFile(path.join(directory, 'capability.json'), capability);
	expect(await requestLifecycle(directory, { action: 'prepare' })).toBeUndefined();
	expect(connected).not.toHaveBeenCalled();
});

it('falls back when capability metadata disappears', async () => {
	const directory = await fixture();
	await rm(path.join(directory, 'capability.json'));
	expect(await requestLifecycle(directory, { action: 'status' })).toBeUndefined();
});

it('rechecks capability after a runtime restart', async () => {
	const connected = vi.fn((socket: Socket) =>
		socket.once('data', () => socket.end('{"ok":true}\n')),
	);
	const directory = await fixture(connected);
	expect(await requestLifecycle(directory, { action: 'status' })).toBe('{"ok":true}');
	await writeFile(path.join(directory, 'capability.json'), '{"supported":false,"protocol":1}');
	expect(await requestLifecycle(directory, { action: 'prepare' })).toBeUndefined();
	expect(connected).toHaveBeenCalledTimes(1);
});

it.each(['x'.repeat(64 * 1024), 'é'.repeat(32 * 1024)])(
	'rejects oversized request bytes before connecting (%#)',
	async (entry) => {
		const connected = vi.fn((socket: Socket) => socket.end());
		const directory = await fixture(connected);
		await expect(requestLifecycle(directory, { action: 'prepare', entry })).rejects.toThrow(
			'CAPTURE_UNAVAILABLE',
		);
		expect(connected).not.toHaveBeenCalled();
	},
);

it('rejects unserializable requests before connecting', async () => {
	const connected = vi.fn((socket: Socket) => socket.end());
	const directory = await fixture(connected);
	await expect(requestLifecycle(directory, { generation: 1n })).rejects.toThrow();
	expect(connected).not.toHaveBeenCalled();
});

it('rejects a truncated reply and allows a later request on a fresh connection', async () => {
	let attempts = 0;
	const directory = await fixture((socket) =>
		socket.once('data', () => {
			socket.end(++attempts === 1 ? '{"ok":' : '{"ok":true}\n');
		}),
	);
	await expect(requestLifecycle(directory, { action: 'prepare' })).rejects.toThrow(
		'CAPTURE_UNAVAILABLE',
	);
	expect(attempts).toBe(1);
	expect(await requestLifecycle(directory, { action: 'status' })).toBe('{"ok":true}');
	expect(attempts).toBe(2);
});

it('accepts a response at the byte limit', async () => {
	const response = 'x'.repeat(1024 * 1024 - 1);
	const directory = await fixture((socket) =>
		socket.once('data', () => socket.end(`${response}\n`)),
	);
	expect(await requestLifecycle(directory, { action: 'status' })).toBe(response);
});

it('closes a timed-out socket even if the peer keeps sending partial data', async () => {
	const closed = Promise.withResolvers<void>();
	const directory = await fixture((socket) => {
		socket.on('error', () => {});
		socket.resume();
		const interval = setInterval(() => socket.write(' '), 5);
		socket.once('close', () => {
			clearInterval(interval);
			closed.resolve();
		});
	});
	await expect(requestLifecycle(directory, { action: 'status' }, 100)).rejects.toThrow(
		'CAPTURE_UNAVAILABLE',
	);
	await closed.promise;
});
