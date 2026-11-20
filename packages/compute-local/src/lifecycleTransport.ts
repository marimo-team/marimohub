import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

// The supervisor restricts control.sock to mode 0600 in its private directory.
export async function requestLifecycle(
	directory: string,
	request: Record<string, unknown>,
	timeoutMs = 55_000,
): Promise<string | undefined> {
	const payload = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(payload) > 64 * 1024) throw new Error('CAPTURE_UNAVAILABLE');
	try {
		const capability = JSON.parse(await readFile(path.join(directory, 'capability.json'), 'utf8'));
		if (
			typeof capability !== 'object' ||
			capability === null ||
			!('supported' in capability) ||
			capability.supported !== true ||
			!('protocol' in capability) ||
			capability.protocol !== 1
		)
			return undefined;
	} catch {
		return undefined;
	}
	return new Promise((resolve, reject) => {
		const socket = createConnection(path.join(directory, 'control.sock'));
		let dispatched = false;
		let bytes = 0;
		const chunks: Buffer[] = [];
		const finish = (error?: Error, reply?: string) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(reply);
		};
		const fail = () => finish(new Error('CAPTURE_UNAVAILABLE'));
		const timer = setTimeout(fail, timeoutMs);
		socket.once('connect', () => {
			dispatched = true;
			socket.write(payload);
		});
		socket.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1024 * 1024) {
				fail();
				return;
			}
			chunks.push(chunk);
			if (chunk.includes(10)) {
				finish(undefined, Buffer.concat(chunks).toString('utf8').split('\n')[0]);
			}
		});
		socket.once('error', (error: NodeJS.ErrnoException) => {
			// The Python client owns dead-supervisor recovery; never replay after connect.
			if (!dispatched && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) finish();
			else fail();
		});
		socket.once('end', fail);
	});
}
