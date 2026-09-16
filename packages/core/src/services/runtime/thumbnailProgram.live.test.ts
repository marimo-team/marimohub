import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { expect, it } from 'vitest';
import { THUMBNAIL_PROGRAM } from './thumbnailProgram';
import { validateThumbnailPng } from '../content/thumbnailPng';

const run = promisify(execFile);
const python = process.env.MARIMOHUB_THUMBNAIL_TEST_PYTHON;
it.skipIf(!python).each([false, true])(
	'renders isolated outputs and rejects missing installed assets (missing=%s)',
	async (missingAsset) => {
		const dir = await mkdtemp(join(tmpdir(), 'thumbnail-smoke-'));
		let requests = 0;
		let udpPackets = 0;
		let tcpConnections = 0;
		const udp = createSocket('udp4');
		udp.on('message', () => udpPackets++);
		const tcp = createTcpServer((socket) => {
			tcpConnections++;
			socket.destroy();
		});
		const server = createServer((_req, res) => {
			requests++;
			res.end('unexpected');
		});
		server.on('upgrade', (_req, socket) => {
			requests++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
		await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
		try {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing test port');
			const tcpAddress = tcp.address();
			if (!tcpAddress || typeof tcpAddress === 'string') throw new Error('Missing TCP test port');
			const iceServers = [
				{ urls: `stun:127.0.0.1:${udp.address().port}` },
				{
					urls: `turn:127.0.0.1:${tcpAddress.port}?transport=tcp`,
					username: 'test',
					credential: 'test',
				},
				{
					urls: `turns:127.0.0.1:${tcpAddress.port}?transport=tcp`,
					username: 'test',
					credential: 'test',
				},
			];
			const fixture = await readFile(new URL('./fixtures/thumbnail.html', import.meta.url), 'utf8');
			const input = join(dir, 'snapshot.html');
			await writeFile(
				input,
				fixture.replace(
					'</body>',
					`${missingAsset ? '<link rel="stylesheet" href="/assets/not-installed.css">' : ''}<script>
window.thumbnailPeers = ${JSON.stringify(iceServers)}.map(server => {
  const peer = new RTCPeerConnection({iceServers: [server]});
  peer.createDataChannel('thumbnail');
  peer.createOffer().then(offer => peer.setLocalDescription(offer));
  return peer;
});
fetch('http://127.0.0.1:${address.port}/mutation', {method:'POST'}).catch(()=>{});
new WebSocket('ws://127.0.0.1:${address.port}/kernel');
</script></body>`,
				),
			);
			const { stdout } = await run(
				python!,
				['-c', THUMBNAIL_PROGRAM, input, String(Date.now() / 1000 + 10)],
				{ timeout: 12_000, maxBuffer: 5 * 1024 * 1024 },
			);
			const result = JSON.parse(stdout) as { status: string; png: string };
			expect(requests).toBe(0);
			expect(udpPackets).toBe(0);
			expect(tcpConnections).toBe(0);
			await expect(readFile(input)).rejects.toThrow();
			if (missingAsset) {
				expect(result.status).toBe('render_failed');
				expect(result.png).toBeUndefined();
				return;
			}
			expect(result.status).toBe('ok');
			const png = new Uint8Array(Buffer.from(result.png, 'base64'));
			validateThumbnailPng(png);
			// An empty 960×540 Chromium PNG is approximately 2 KB; this fixture contains rendered text.
			expect(png.byteLength).toBeGreaterThan(6000);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await new Promise<void>((resolve) => udp.close(() => resolve()));
			await new Promise<void>((resolve) => tcp.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		}
	},
	15_000,
);
