import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SandboxId } from '@marimo-hub/core';
import { FargateCompute } from './index';

const live = process.env.MARIMOHUB_FARGATE_LIVE_TEST === '1' ? describe : describe.skip;

function liveCompute(): FargateCompute {
	const required = [
		'MARIMOHUB_COMPUTE_FARGATE_CLUSTER',
		'MARIMOHUB_COMPUTE_FARGATE_TASK_DEFINITION',
		'MARIMOHUB_COMPUTE_FARGATE_SUBNETS',
		'MARIMOHUB_COMPUTE_FARGATE_SECURITY_GROUPS',
		'MARIMOHUB_COMPUTE_FARGATE_OWNER',
		'MARIMOHUB_COMPUTE_FARGATE_AGENT_SECRET',
	];
	for (const key of required) expect(process.env[key], key).toBeTruthy();
	return new FargateCompute({
		cluster: process.env.MARIMOHUB_COMPUTE_FARGATE_CLUSTER!,
		taskDefinition: process.env.MARIMOHUB_COMPUTE_FARGATE_TASK_DEFINITION!,
		subnets: process.env.MARIMOHUB_COMPUTE_FARGATE_SUBNETS!.split(',').map((value) => value.trim()),
		securityGroups: process.env
			.MARIMOHUB_COMPUTE_FARGATE_SECURITY_GROUPS!.split(',')
			.map((value) => value.trim()),
		owner: process.env.MARIMOHUB_COMPUTE_FARGATE_OWNER!,
		agentSecret: process.env.MARIMOHUB_COMPUTE_FARGATE_AGENT_SECRET!,
		exposureMode: 'proxy',
	});
}

live('Fargate live acceptance', () => {
	it('launches, exercises, reconnects, and tears down a disposable task', async () => {
		const compute = liveCompute();
		await compute.healthCheck();
		const id = `sb-${randomUUID().replaceAll('-', '').slice(0, 16)}` as SandboxId;
		const instance = compute.create(id, { reuse: false });
		let reconnect: ReturnType<FargateCompute['create']> | undefined;
		try {
			await instance.ready?.();
			const exec = await instance.exec("printf 'fargate-ready'");
			expect(exec).toMatchObject({ success: true, stdout: 'fargate-ready' });
			const bytes = new Uint8Array([0xff, 0x00, 0x80, 0x01]);
			await instance.writeFiles([{ path: '/workspace/live.bin', content: bytes }]);
			const read = await instance.readFile('/workspace/live.bin');
			expect(read).toMatchObject({ success: true, encoding: 'base64' });
			if (read.success) expect(Buffer.from(read.content, 'base64')).toEqual(Buffer.from(bytes));

			const process = await instance.startProcess('python3 -m http.server 2720 --bind 0.0.0.0', {
				processId: 'marimohub-live-http',
				timeout: 60_000,
			});
			await process.waitForPort(2720, { timeout: 30_000 });
			expect((await instance.exposePort(2720, { hostname: 'unused' })).url).toContain(':2720');

			const secondCompute = liveCompute();
			reconnect = secondCompute.create(id, { reuse: true });
			await reconnect.ready?.();
			expect((await secondCompute.listActive()).some((entry) => entry.id === id)).toBe(true);
		} finally {
			await reconnect?.destroy().catch(() => {});
			await instance.destroy().catch(() => {});
		}
	}, 180_000);
});
