import { expect, it } from 'vitest';
import { SandboxId } from '@marimo-hub/core/ids';
import { expectExecResult } from '@marimo-hub/core/testing/result-assertions';
import { DockerCompute } from './docker';

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
