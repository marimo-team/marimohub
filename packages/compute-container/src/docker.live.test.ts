import { expect, it } from 'vitest';
import { SandboxId } from '@marimo-hub/core/ids';
import { expectExecResult } from '@marimo-hub/core/testing/result-assertions';
import { DockerCompute } from './docker';

it
	.skipIf(process.env.MARIMOHUB_TEST_DOCKER !== '1')
	.each(['TERM', 'TERM then KILL', 'natural exit'])(
	'reaps background descendants and their supervisor after %s',
	async (exit) => {
		const sandbox = new DockerCompute({
			image: process.env.MARIMOHUB_TEST_DOCKER_IMAGE ?? 'python:3.12-slim',
			ownerTag: 'process-cleanup-live-test',
		}).create(SandboxId.create());
		try {
			await sandbox.writeFiles([
				{
					path: '/tmp/background.py',
					content: `import http.server, os, signal
${exit === 'TERM then KILL' ? 'signal.signal(signal.SIGTERM, signal.SIG_IGN)' : ''}
with open('/tmp/background.pid', 'w') as record:
    record.write(str(os.getpid()))
with open('/tmp/supervisor.pid', 'w') as record:
    record.write(str(os.getpgrp()))
server = http.server.HTTPServer(('127.0.0.1', 4096), http.server.SimpleHTTPRequestHandler)
server.timeout = 0.1
while not os.path.exists('/tmp/exit'):
    server.handle_request()
`,
				},
			]);
			const background = await sandbox.startProcess(
				'python3 /tmp/background.py & echo $$ > /tmp/leader.pid',
			);
			await background.waitForPort(4096, { timeout: 10_000 });
			const exited = async (record: string) =>
				(await sandbox.exec(`test ! -d "/proc/$(cat ${record})"`)).success;
			await expect.poll(() => exited('/tmp/leader.pid'), { timeout: 5_000 }).toBe(true);
			if (exit === 'natural exit') {
				expectExecResult(await sandbox.exec('touch /tmp/exit'), { success: true });
			} else {
				await background.kill();
				if (exit === 'TERM then KILL') {
					expect(await exited('/tmp/background.pid')).toBe(false);
					await background.kill('SIGKILL');
				}
			}
			await expect.poll(() => exited('/tmp/background.pid'), { timeout: 5_000 }).toBe(true);
			await expect.poll(() => exited('/tmp/supervisor.pid'), { timeout: 5_000 }).toBe(true);
			await background.kill();
		} finally {
			await sandbox.destroy();
		}
	},
	30_000,
);

it.skipIf(process.env.MARIMOHUB_TEST_DOCKER !== '1')(
	'serves multiple ports and reaps a stopped surface without disrupting the kernel',
	async () => {
		const config = {
			image: process.env.MARIMOHUB_TEST_DOCKER_IMAGE ?? 'python:3.12-slim',
			host: '127.0.0.1',
			surfacePorts: [4096],
			ownerTag: 'multiport-live-test',
		};
		const id = SandboxId.create();
		const sandbox = new DockerCompute(config).create(id);
		try {
			await sandbox.writeFiles([
				{ path: '/tmp/kernel/index.html', content: 'kernel' },
				{ path: '/tmp/surface/index.html', content: 'surface' },
			]);
			const kernel = await sandbox.startProcess('exec python3 -m http.server 2718 --bind 0.0.0.0', {
				cwd: '/tmp/kernel',
			});
			await kernel.waitForPort(2718, { timeout: 10_000 });
			const command = 'echo $$ > /tmp/surface.pid; exec python3 -m http.server 4096 --bind 0.0.0.0';
			const surface = await sandbox.startProcess(command, { cwd: '/tmp/surface' });
			await surface.waitForPort(4096, { timeout: 10_000 });
			const kernelUrl = await sandbox.exposePort(2718, { hostname: 'ignored' });
			const surfaceUrl = await sandbox.exposePort(4096, { hostname: 'ignored' });
			expect(kernelUrl.url).not.toBe(surfaceUrl.url);
			const read = async (url: string) =>
				(await fetch(url, { signal: AbortSignal.timeout(5_000) })).text();
			expect(await read(kernelUrl.url)).toBe('kernel');
			expect(await read(surfaceUrl.url)).toBe('surface');

			const reconnected = new DockerCompute(config).create(id);
			expect(await reconnected.exposePort(4096, { hostname: 'ignored' })).toEqual(surfaceUrl);
			expectExecResult(await reconnected.exec('kill -TERM "$(cat /tmp/surface.pid)"'), {
				success: true,
			});
			await expect
				.poll(
					async () => (await reconnected.exec('test ! -d "/proc/$(cat /tmp/surface.pid)"')).success,
					{ timeout: 5_000 },
				)
				.toBe(true);
			expect(await read(kernelUrl.url)).toBe('kernel');
			await surface.kill();

			const restarted = await reconnected.startProcess(command, { cwd: '/tmp/surface' });
			await restarted.waitForPort(4096, { timeout: 10_000 });
			expect(await read(surfaceUrl.url)).toBe('surface');
			expect(await read(kernelUrl.url)).toBe('kernel');
		} finally {
			await sandbox.destroy();
		}
	},
	60_000,
);
