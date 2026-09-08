import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import type {
	FargateClient,
	FargateRunTaskInput,
	FargateTask,
	FargateTaskDefinition,
} from './shared';
import {
	CREATED_AT_TAG,
	DEFAULT_CONTAINER_NAME,
	FARGATE_PROTOCOL_VERSION,
	fargateProfileResources,
	FargateCompute,
	IMAGE_KEY_TAG,
	OWNER_TAG,
	SANDBOX_ID_TAG,
	deriveAgentToken,
	deterministicClientToken,
} from './index';

const ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const TOKEN = 'secret '.repeat(6);

class FakeEcs implements FargateClient {
	readonly runInputs: FargateRunTaskInput[] = [];
	readonly stopped: string[] = [];
	tasks = new Map<string, FargateTask>();
	private sequence = 0;

	async runTask(input: FargateRunTaskInput) {
		this.runInputs.push(input);
		const arn = `arn:aws:ecs:region:123:task/${++this.sequence}`;
		this.tasks.set(arn, {
			taskArn: arn,
			taskDefinitionArn: input.taskDefinition,
			lastStatus: 'PENDING',
			desiredStatus: 'RUNNING',
			createdAt: '2026-09-08T12:00:00.000Z',
			containers: [
				{ name: input.overrides?.containerOverrides?.[0]?.name ?? DEFAULT_CONTAINER_NAME },
			],
			attachments: [{ type: 'eni', details: [{ name: 'privateIPv4Address', value: '10.0.0.9' }] }],
			tags: input.tags,
		});
		return { tasks: [this.tasks.get(arn)!] };
	}

	async describeTasks(_cluster: string, arns: readonly string[]) {
		const tasks = arns.flatMap((arn) => {
			const task = this.tasks.get(arn);
			if (!task) return [];
			if (arn.startsWith('arn:')) task.lastStatus = 'RUNNING';
			return [task];
		});
		return { tasks };
	}

	async listTasks() {
		return { taskArns: [...this.tasks.keys()] };
	}

	async stopTask(_cluster: string, arn: string) {
		this.stopped.push(arn);
		const task = this.tasks.get(arn);
		if (task) task.lastStatus = 'STOPPED';
	}

	async describeTaskDefinition(_taskDefinition: string): Promise<FargateTaskDefinition> {
		return { containerNames: [DEFAULT_CONTAINER_NAME] };
	}

	async describeCluster() {}
}

function makeCompute(
	client: FakeEcs,
	extra: Partial<ConstructorParameters<typeof FargateCompute>[0]> = {},
) {
	return new FargateCompute({
		cluster: 'marimo',
		taskDefinition: 'family:7',
		subnets: ['subnet-a'],
		securityGroups: ['sg-hub'],
		owner: 'deployment-a',
		agentSecret: TOKEN,
		exposureMode: 'proxy',
		client,
		...extra,
	});
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url.endsWith('/health')) {
				return Response.json({ ok: true, protocolVersion: FARGATE_PROTOCOL_VERSION });
			}
			return Response.json({ success: true, stdout: '', stderr: '', exitCode: 0 });
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe('Fargate profile selection', () => {
	it('rounds CPU and memory to the smallest valid pair', () => {
		expect(fargateProfileResources({ cpu: 0.25, memoryBytes: 512 * 1024 ** 2 })).toEqual({
			cpu: '256',
			memory: '0.5Gi',
		});
		expect(fargateProfileResources({ cpu: 0.6, memoryBytes: 3 * 1024 ** 3 })).toEqual({
			cpu: '1024',
			memory: '3Gi',
		});
		expect(fargateProfileResources({ memoryBytes: 4 * 1024 ** 3 })).toEqual({
			cpu: '512',
			memory: '4Gi',
		});
	});

	it('rejects GPU and requests above the Fargate maximum', () => {
		expect(() => fargateProfileResources({ gpu: 'A100' })).toThrow(/GPU/);
		expect(() => fargateProfileResources({ cpu: 64 })).toThrow(/largest supported/);
	});
});

describe('FargateCompute', () => {
	it('launches one private task with ownership, token, and profile overrides', async () => {
		const client = new FakeEcs();
		const instance = makeCompute(client).create(ID, {
			reuse: false,
			resources: { cpu: 1, memoryBytes: 4 * 1024 ** 3 },
		});
		await instance.ready?.();
		const input = client.runInputs[0];
		expect(input).toMatchObject({
			startedBy: 'deployment-a',
			clientToken: deterministicClientToken('deployment-a', ID),
			networkConfiguration: {
				assignPublicIp: false,
				subnets: ['subnet-a'],
				securityGroups: ['sg-hub'],
			},
			overrides: { cpu: '1024', memory: '4Gi' },
		});
		expect(input.tags).toEqual(
			expect.arrayContaining([
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
				{ key: IMAGE_KEY_TAG, value: 'default' },
				{ key: CREATED_AT_TAG, value: expect.any(String) },
			]),
		);
		expect((await instance.exposePort(2718, { hostname: 'hub.example' })).url).toBe(
			'http://10.0.0.9:2718',
		);
		await instance.destroy();
		expect(client.stopped).toHaveLength(1);
	});

	it('reconnects a task from its old task-definition revision', async () => {
		const client = new FakeEcs();
		client.tasks.set('old-task', {
			taskArn: 'old-task',
			taskDefinitionArn: 'family:3',
			lastStatus: 'RUNNING',
			desiredStatus: 'RUNNING',
			createdAt: '2026-09-08T12:00:00.000Z',
			containers: [{ name: 'marimo' }],
			attachments: [{ type: 'eni', details: [{ name: 'privateIPv4Address', value: '10.0.0.10' }] }],
			tags: [
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
				{ key: IMAGE_KEY_TAG, value: 'default' },
			],
		});
		const instance = makeCompute(client, { taskDefinition: 'family:9' }).create(ID);
		await instance.ready?.();
		expect(client.runInputs).toHaveLength(0);
		expect((await instance.exposePort(2718, { hostname: 'hub.example' })).url).toBe(
			'http://10.0.0.10:2718',
		);
	});

	it('rejects an unknown logical image key before ECS launch', async () => {
		const client = new FakeEcs();
		const instance = makeCompute(client).create(ID, { image: 'not-configured', reuse: false });
		await expect(instance.ready?.()).rejects.toThrow(/not-configured/);
		expect(client.runInputs).toHaveLength(0);
	});

	it('rejects non-proxy exposure and invalid owner/secret configuration', () => {
		const client = new FakeEcs();
		expect(() => makeCompute(client, { exposureMode: 'subdomain' })).toThrow(/proxy only/);
		expect(() => makeCompute(client, { owner: '' })).toThrow(/owner/);
		expect(() => makeCompute(client, { agentSecret: 'short' })).toThrow(/32 bytes/);
	});

	it('limits listActive to running deployment-owned sandboxes', async () => {
		const client = new FakeEcs();
		client.tasks.set('owned', {
			taskArn: 'owned',
			lastStatus: 'RUNNING',
			desiredStatus: 'RUNNING',
			tags: [
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
			],
		});
		client.tasks.set('pending', {
			taskArn: 'pending',
			lastStatus: 'PENDING',
			desiredStatus: 'RUNNING',
			tags: [
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: 'sb-bbbbbbbbbbbbbbbb' },
			],
		});
		client.tasks.set('other', {
			taskArn: 'other',
			lastStatus: 'RUNNING',
			desiredStatus: 'RUNNING',
			tags: [
				{ key: OWNER_TAG, value: 'other' },
				{ key: SANDBOX_ID_TAG, value: 'sb-cccccccccccccccc' },
			],
		});
		expect(await makeCompute(client).listActive()).toEqual([
			expect.objectContaining({ id: ID, taskArn: 'owned' }),
		]);
	});
});

describe('agent token derivation', () => {
	it('is deterministic and per sandbox', () => {
		expect(deriveAgentToken(TOKEN, ID)).toBe(deriveAgentToken(TOKEN, ID));
		expect(deriveAgentToken(TOKEN, ID)).not.toBe(deriveAgentToken(TOKEN, 'sb-bbbbbbbbbbbbbbbb'));
	});
});
