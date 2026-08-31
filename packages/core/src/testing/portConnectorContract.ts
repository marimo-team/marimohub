import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxId } from '../ids';
import type { SandboxPortConnector } from '../ports/sandbox';

const CONTRACT_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const CONTRACT_PORT = 2222;

export function portConnectorContract(
	name: string,
	makeConnector: (
		publishedPort: number,
		sandboxId: SandboxId,
	) => SandboxPortConnector | Promise<SandboxPortConnector>,
): void {
	describe(`Sandbox port connector contract: ${name}`, () => {
		let server: Server;
		let sockets: Set<Socket>;
		let publishedPort: number;

		beforeEach(async () => {
			sockets = new Set();
			server = createServer((socket) => {
				sockets.add(socket);
				socket.on('close', () => sockets.delete(socket));
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			publishedPort = (server.address() as AddressInfo).port;
		});

		afterEach(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it('relays bytes in both directions without returning an endpoint', async () => {
			const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
			const connector = await makeConnector(publishedPort, CONTRACT_ID);
			const connection = await connector.connectPort(CONTRACT_ID, CONTRACT_PORT);
			const socket = await accepted;
			expect(Object.keys(connection).sort()).toEqual(['close', 'readable', 'writable']);

			const received = new Promise<Buffer>((resolve) => socket.once('data', resolve));
			const writer = connection.writable.getWriter();
			await writer.write(new Uint8Array([0, 1, 2, 255]));
			expect(await received).toEqual(Buffer.from([0, 1, 2, 255]));

			const reader = connection.readable.getReader();
			socket.write(Buffer.from([255, 2, 1, 0]));
			expect((await reader.read()).value).toEqual(new Uint8Array([255, 2, 1, 0]));
			reader.releaseLock();
			writer.releaseLock();
			await connection.close();
		});

		it('propagates explicit connection closure', async () => {
			const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
			const connection = await (
				await makeConnector(publishedPort, CONTRACT_ID)
			).connectPort(CONTRACT_ID, CONTRACT_PORT);
			const socket = await accepted;
			const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
			await connection.close();
			await closed;
		});

		it('propagates peer half-close to the readable stream', async () => {
			const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
			const connection = await (
				await makeConnector(publishedPort, CONTRACT_ID)
			).connectPort(CONTRACT_ID, CONTRACT_PORT);
			const socket = await accepted;
			const reader = connection.readable.getReader();

			socket.end();

			expect((await reader.read()).done).toBe(true);
			reader.releaseLock();
			await connection.close();
		});

		it('applies writable-stream backpressure', async () => {
			const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
			const connection = await (
				await makeConnector(publishedPort, CONTRACT_ID)
			).connectPort(CONTRACT_ID, CONTRACT_PORT);
			const socket = await accepted;
			socket.pause();
			const writer = connection.writable.getWriter();
			let settled = false;
			const write = writer.write(new Uint8Array(16 * 1024 * 1024)).then(() => {
				settled = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(settled).toBe(false);
			socket.resume();
			await write;
			writer.releaseLock();
			await connection.close();
		});
	});
}
