import { describe, expect, it, vi } from 'vitest';
import { createFargateClient } from './client';

function makeSdk() {
	const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
		const name = command.constructor.name;
		if (name === 'RunTaskCommand') {
			return {
				tasks: [
					{
						taskArn: 'task-1',
						taskDefinitionArn: 'family:7',
						lastStatus: 'RUNNING',
						createdAt: new Date('2026-09-08T12:00:00.000Z'),
						containers: [{ name: 'marimo' }],
					},
				],
			};
		}
		if (name === 'DescribeTasksCommand') return { tasks: [] };
		if (name === 'ListTasksCommand') return { taskArns: [], nextToken: undefined };
		if (name === 'StopTaskCommand') return {};
		if (name === 'DescribeClustersCommand') return { clusters: [{ clusterName: 'marimo' }] };
		if (name === 'DescribeTaskDefinitionCommand') {
			return {
				taskDefinition: {
					taskDefinitionArn: 'family:7',
					family: 'family',
					revision: 7,
					taskRoleArn: 'arn:aws:iam::123:role/kernel',
					networkMode: 'awsvpc',
					requiresCompatibilities: ['FARGATE'],
					containerDefinitions: [
						{
							name: 'marimo',
							environment: [{ name: 'AWS_REGION', value: 'us-east-1' }],
							secrets: [{ name: 'AWS_ACCESS_KEY_ID', valueFrom: 'secret-arn' }],
						},
					],
				},
			};
		}
		throw new Error(`unexpected command ${name}`);
	});
	return { send };
}

describe('createFargateClient', () => {
	it('translates RunTask network, tags, overrides, and launch type', async () => {
		const sdk = makeSdk();
		const client = createFargateClient({ client: sdk as never });
		await client.runTask({
			cluster: 'marimo',
			taskDefinition: 'family:7',
			startedBy: 'deployment-a',
			clientToken: 'token',
			platformVersion: 'LATEST',
			count: 1,
			networkConfiguration: {
				subnets: ['subnet-a'],
				securityGroups: ['sg-a'],
				assignPublicIp: false,
			},
			tags: [{ key: 'owner', value: 'deployment-a' }],
			overrides: {
				cpu: '1024',
				memory: '4096',
				containerOverrides: [
					{ name: 'marimo', environment: [{ name: 'TOKEN', value: 'derived' }] },
				],
			},
		});
		const command = sdk.send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
		expect(command.input).toMatchObject({
			launchType: 'FARGATE',
			startedBy: 'deployment-a',
			networkConfiguration: {
				awsvpcConfiguration: {
					subnets: ['subnet-a'],
					securityGroups: ['sg-a'],
					assignPublicIp: 'DISABLED',
				},
			},
			tags: [{ key: 'owner', value: 'deployment-a' }],
			overrides: { cpu: '1024', memory: '4096' },
		});
	});

	it('uses startedBy as the only ListTasks filter', async () => {
		const sdk = makeSdk();
		const client = createFargateClient({ client: sdk as never });
		await client.listTasks('marimo', 'deployment-a', 'next-page');
		const command = sdk.send.mock.calls.find(
			([candidate]) => candidate.constructor.name === 'ListTasksCommand',
		)?.[0] as { input: Record<string, unknown> };
		expect(command.input).toEqual({
			cluster: 'marimo',
			startedBy: 'deployment-a',
			nextToken: 'next-page',
		});
		expect(command.input).not.toHaveProperty('launchType');
	});

	it('requests task tags only when they are needed', async () => {
		const sdk = makeSdk();
		const client = createFargateClient({ client: sdk as never });
		await client.describeTasks('marimo', ['task-1'], true);
		await client.describeTaskDefinition('family:7');
		const describeTasks = sdk.send.mock.calls.find(
			([candidate]) => candidate.constructor.name === 'DescribeTasksCommand',
		)?.[0] as { input: Record<string, unknown> };
		const describeDefinition = sdk.send.mock.calls.find(
			([candidate]) => candidate.constructor.name === 'DescribeTaskDefinitionCommand',
		)?.[0] as { input: Record<string, unknown> };
		expect(describeTasks.input).toEqual({
			cluster: 'marimo',
			tasks: ['task-1'],
			include: ['TAGS'],
		});
		expect(describeDefinition.input).toEqual({ taskDefinition: 'family:7' });
	});

	it('maps task definitions and validates a cluster', async () => {
		const sdk = makeSdk();
		const client = createFargateClient({ client: sdk as never });
		expect(await client.describeTaskDefinition('family:7')).toEqual({
			taskDefinitionArn: 'family:7',
			family: 'family',
			revision: 7,
			taskRoleArn: 'arn:aws:iam::123:role/kernel',
			networkMode: 'awsvpc',
			requiresCompatibilities: ['FARGATE'],
			containerNames: ['marimo'],
			staticCredentialContainers: ['marimo'],
		});
		await expect(client.describeCluster('marimo')).resolves.toBeUndefined();
	});
});
