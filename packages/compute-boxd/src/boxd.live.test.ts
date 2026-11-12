import { describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SandboxId } from '@marimo-hub/core/ids';
import { BoxdCompute } from './index';

const live = process.env.MARIMOHUB_BOXD_LIVE_TEST === '1' ? describe : describe.skip;

function liveCompute(): BoxdCompute {
	expect(process.env.MARIMOHUB_COMPUTE_BOXD_API_KEY, 'MARIMOHUB_COMPUTE_BOXD_API_KEY').toBeTruthy();
	return new BoxdCompute({
		apiKey: process.env.MARIMOHUB_COMPUTE_BOXD_API_KEY!,
		org: process.env.MARIMOHUB_COMPUTE_BOXD_ORG,
		region: process.env.MARIMOHUB_COMPUTE_BOXD_REGION,
		snapshot: process.env.MARIMOHUB_COMPUTE_BOXD_SNAPSHOT,
		namePrefix: process.env.MARIMOHUB_COMPUTE_BOXD_NAME_PREFIX ?? 'marimohub-live-',
		labels: Object.fromEntries(
			(process.env.MARIMOHUB_COMPUTE_BOXD_LABELS ?? '')
				.split(',')
				.filter(Boolean)
				.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
		),
	});
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url);
			if (res.ok || attempt >= 30) return { status: res.status, body: await res.text() };
		} catch (error) {
			// A new named route answers TLS once its certificate is issued.
			if (attempt >= 30) throw error;
		}
		await sleep(2000);
	}
}

live('boxd live acceptance', () => {
	it('creates, exercises, reconnects, and destroys one machine', async () => {
		const compute = liveCompute();
		const id = `sb-${randomUUID().replaceAll('-', '').slice(0, 16)}` as SandboxId;
		const instance = compute.create(id);
		try {
			await instance.ready?.();

			expect(await instance.exec("printf 'boxd-ready'")).toMatchObject({
				success: true,
				stdout: 'boxd-ready',
			});
			expect(await instance.exec('echo out; echo err >&2; exit 3')).toMatchObject({
				success: false,
				stdout: 'out\n',
				stderr: 'err\n',
			});
			await instance.setEnvVars({ MH_LIVE: "it's set" });
			expect((await instance.exec('printf %s "$MH_LIVE"')).stdout).toBe("it's set");
			await expect(
				instance.exec('head -c 100000 /dev/zero', { maxOutputBytes: 1000, timeout: 10_000 }),
			).rejects.toThrow('exceeded byte limit');

			const payload = randomBytes(5 * 1024 * 1024);
			await instance.writeFiles([{ path: '/workspace/live/payload.bin', content: payload }]);
			const remoteSum = await instance.exec('sha256sum /workspace/live/payload.bin');
			const localSum = createHash('sha256').update(payload).digest('hex');
			expect(remoteSum.stdout.split(' ')[0]).toBe(localSum);
			expect((await instance.exec('test -O /workspace/live/payload.bin')).success).toBe(true);
			const read = await instance.readFile('/workspace/live/payload.bin');
			expect(read).toMatchObject({ success: true, encoding: 'base64' });
			if (read.success) {
				expect(createHash('sha256').update(Buffer.from(read.content, 'base64')).digest('hex')).toBe(
					localSum,
				);
			}
			expect(await instance.readFile('/workspace/live/missing.txt')).toMatchObject({
				success: false,
				error: { code: 'NOT_FOUND' },
			});

			await instance.writeFiles([{ path: '/workspace/live/index.html', content: 'kernel-port' }]);
			const kernel = await instance.startProcess('python3 -m http.server 2718 --bind 0.0.0.0', {
				cwd: '/workspace/live',
			});
			await kernel.waitForPort(2718, { timeout: 30_000 });
			const kernelUrl = (await instance.exposePort(2718, { hostname: '' })).url;
			expect(await fetchText(`${kernelUrl}/index.html`)).toEqual({
				status: 200,
				body: 'kernel-port',
			});

			await instance.writeFiles([{ path: '/workspace/side/index.html', content: 'second-port' }]);
			const side = await instance.startProcess('python3 -m http.server 8443 --bind 0.0.0.0', {
				cwd: '/workspace/side',
			});
			await side.waitForPort(8443, { timeout: 30_000 });
			const sideUrl = (await instance.exposePort(8443, { hostname: '' })).url;
			expect(sideUrl).not.toBe(kernelUrl);
			expect(await fetchText(`${sideUrl}/index.html`)).toEqual({
				status: 200,
				body: 'second-port',
			});

			const second = liveCompute();
			const reconnect = second.connectExisting(id);
			expect((await reconnect.exec('ss -ltn | grep -c ":2718 "')).stdout.trim()).toBe('1');
			expect((await second.listActive()).some((entry) => entry.id === id)).toBe(true);

			await kernel.kill();
			await side.kill();
			await reconnect.destroy();
			expect((await liveCompute().listActive()).some((entry) => entry.id === id)).toBe(false);
		} finally {
			await instance.destroy();
		}
	}, 300_000);
});
