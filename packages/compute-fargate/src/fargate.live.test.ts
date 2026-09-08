import { describe, expect, it } from 'vitest';
import { FargateCompute } from './index';

const live = process.env.MARIMOHUB_FARGATE_LIVE === '1' ? describe : describe.skip;

live('Fargate live acceptance', () => {
	it('is opt-in and starts through the configured private agent', async () => {
		const required = [
			'MARIMOHUB_COMPUTE_FARGATE_CLUSTER',
			'MARIMOHUB_COMPUTE_FARGATE_TASK_DEFINITION',
			'MARIMOHUB_COMPUTE_FARGATE_SUBNETS',
			'MARIMOHUB_COMPUTE_FARGATE_SECURITY_GROUPS',
			'MARIMOHUB_COMPUTE_FARGATE_OWNER',
			'MARIMOHUB_COMPUTE_FARGATE_AGENT_SECRET',
		];
		for (const key of required) expect(process.env[key], key).toBeTruthy();
		const compute = new FargateCompute({
			cluster: process.env.MARIMOHUB_COMPUTE_FARGATE_CLUSTER!,
			taskDefinition: process.env.MARIMOHUB_COMPUTE_FARGATE_TASK_DEFINITION!,
			subnets: process.env.MARIMOHUB_COMPUTE_FARGATE_SUBNETS!.split(','),
			securityGroups: process.env.MARIMOHUB_COMPUTE_FARGATE_SECURITY_GROUPS!.split(','),
			owner: process.env.MARIMOHUB_COMPUTE_FARGATE_OWNER!,
			agentSecret: process.env.MARIMOHUB_COMPUTE_FARGATE_AGENT_SECRET!,
			exposureMode: 'proxy',
		});
		await compute.healthCheck();
	});
});
