import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import {
	computeContract,
	CONTRACT_HIDDEN_FILE,
	CONTRACT_VISIBLE_FILE,
	isContractNonDirectoryFindCommand,
	scriptContractLaunch,
} from '@marimo-hub/core/testing/compute-contract';
import type {
	FargateClient,
	FargateRunTaskInput,
	FargateTask,
	FargateTaskDefinition,
} from './shared';
import {
	CREATED_AT_TAG,
	DEFAULT_CONTAINER_NAME,
	AGENT_HEALTH_TIMEOUT_MS,
	FARGATE_PROTOCOL_VERSION,
	fargateProfileResources,
	FargateCompute,
	IMAGE_KEY_TAG,
	OWNER_TAG,
	privateIpFromTask,
	SANDBOX_ID_TAG,
	deriveAgentToken,
	deterministicClientToken,
} from './index';

let activeContractWorld: ContractWorld | undefined;

const ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
const TOKEN = 'secret '.repeat(6);

class FakeEcs implements FargateClient {
	readonly runInputs: FargateRunTaskInput[] = [];
	readonly stopped: string[] = [];
	tasks = new Map<string, FargateTask>();
	listCalls = 0;
	describeCalls = 0;
	invisibleDescribes = 0;
	describeFailures = 0;
	describeThrows = 0;
	stopBeforeReady = false;
	describeDelayMs = 0;
	listPageSize = 0;
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
		this.describeCalls++;
		if (this.describeDelayMs > 0)
			await new Promise((resolve) => setTimeout(resolve, this.describeDelayMs));
		if (this.describeThrows > 0) {
			this.describeThrows--;
			throw new Error('eventual consistency');
		}
		if (this.describeFailures > 0) {
			this.describeFailures--;
			return { failures: [{ reason: 'temporary failure' }] };
		}
		if (this.invisibleDescribes > 0) {
			this.invisibleDescribes--;
			return { tasks: [] };
		}
		const tasks = arns.flatMap((arn) => {
			const task = this.tasks.get(arn);
			if (!task) return [];
			if (this.stopBeforeReady) task.lastStatus = 'STOPPED';
			else if (arn.startsWith('arn:')) task.lastStatus = 'RUNNING';
			return [task];
		});
		return { tasks };
	}

	async listTasks(_cluster?: string, _owner?: string, nextToken?: string) {
		this.listCalls++;
		const offset = nextToken ? Number(nextToken) : 0;
		const arns = [...this.tasks.keys()];
		const pageSize = this.listPageSize || (arns.length > 0 ? arns.length : 1);
		const taskArns = arns.slice(offset, offset + pageSize);
		return {
			taskArns,
			nextToken: offset + pageSize < arns.length ? String(offset + pageSize) : undefined,
		};
	}

	async stopTask(_cluster: string, arn: string) {
		this.stopped.push(arn);
		const task = this.tasks.get(arn);
		if (task) {
			task.lastStatus = 'STOPPED';
			task.desiredStatus = 'STOPPED';
		} else throw Object.assign(new Error('task already stopped'), { name: 'ClientException' });
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
		vi.fn(async (url: string, init?: RequestInit) => {
			if (activeContractWorld) return activeContractWorld.fetch(url, init);
			if (url.endsWith('/health')) {
				return Response.json({ ok: true, protocolVersion: FARGATE_PROTOCOL_VERSION });
			}
			return Response.json({ success: true, stdout: '', stderr: '', exitCode: 0 });
		}),
	);
});

afterEach(() => {
	activeContractWorld = undefined;
	vi.unstubAllGlobals();
});

describe('Fargate profile selection', () => {
	it('rounds CPU and memory to the smallest valid pair', () => {
		expect(fargateProfileResources({ cpu: 0.25, memoryBytes: 512 * 1024 ** 2 })).toEqual({
			cpu: '256',
			memory: '512',
		});
		expect(fargateProfileResources({ cpu: 0.6, memoryBytes: 3 * 1024 ** 3 })).toEqual({
			cpu: '1024',
			memory: '3072',
		});
		expect(fargateProfileResources({ memoryBytes: 4 * 1024 ** 3 })).toEqual({
			cpu: '512',
			memory: '4096',
		});
		expect(fargateProfileResources({ cpu: 32, memoryBytes: 59 * 1024 ** 3 })).toEqual({
			cpu: '32768',
			memory: String(60 * 1024),
		});
		expect(fargateProfileResources({ cpu: 32, memoryBytes: 120 * 1024 ** 3 })).toEqual({
			cpu: '32768',
			memory: String(120 * 1024),
		});
		expect(fargateProfileResources({ cpu: 32, memoryBytes: 244 * 1024 ** 3 })).toEqual({
			cpu: '32768',
			memory: String(244 * 1024),
		});
		expect(fargateProfileResources({ cpu: 32, memoryBytes: 121 * 1024 ** 3 })).toEqual({
			cpu: '32768',
			memory: String(244 * 1024),
		});
	});

	it('rejects GPU and requests above the Fargate maximum', () => {
		expect(() => fargateProfileResources({ gpu: 'A100' })).toThrow(/GPU/);
		expect(() => fargateProfileResources({ cpu: 64 })).toThrow(/largest supported/);
		expect(() => fargateProfileResources({ cpu: 32, memoryBytes: 245 * 1024 ** 3 })).toThrow(
			/largest supported/,
		);
		expect(() => fargateProfileResources({ cpu: 33, memoryBytes: 1 })).toThrow(/largest supported/);
	});

	it('keeps a single file above the preferred batch size within the file limit', async () => {
		const client = new FakeEcs();
		const instance = makeCompute(client).create(ID, { reuse: false });
		const fetchMock = vi.mocked(fetch);
		await instance.writeFiles([
			{ path: '/workspace/large.bin', content: new Uint8Array(9 * 1024 * 1024) },
		]);
		const write = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/files/write'));
		expect(write).toBeDefined();
		await expect(
			instance.writeFiles([
				{ path: '/workspace/too-large.bin', content: new Uint8Array(25 * 1024 * 1024 + 1) },
			]),
		).rejects.toThrow(/file limit/);
	});

	it('gives agent operations their requested timeout and preserves zero as unlimited', async () => {
		const client = new FakeEcs();
		const instance = makeCompute(client).create(ID, { reuse: false });
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		await instance.exec('true', { timeout: 123 });
		expect(timeout).toHaveBeenLastCalledWith(1123);
		timeout.mockClear();
		await instance.exec('true', { timeout: 0 });
		await instance.exec('true', { timeout: Infinity });
		expect(timeout).not.toHaveBeenCalled();
		timeout.mockRestore();
	});

	it('does not use a process lifetime timeout as the transport deadline', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/health'))
				return Response.json({ protocolVersion: FARGATE_PROTOCOL_VERSION });
			if (url.endsWith('/processes')) return Response.json({ id: 'process-1' }, { status: 201 });
			return Response.json({ ready: true });
		});
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const process = await makeCompute(new FakeEcs())
			.create(ID, { reuse: false })
			.startProcess('true', {
				timeout: 1,
			});
		expect(timeout).toHaveBeenCalledWith(AGENT_HEALTH_TIMEOUT_MS);
		expect(timeout).toHaveBeenLastCalledWith(120_000);
		timeout.mockClear();
		await process.waitForPort(2718, { timeout: 123 });
		expect(timeout).toHaveBeenLastCalledWith(1123);
		timeout.mockRestore();
	});

	it('reads the private IP from the official ECS ENI attachment shape', () => {
		expect(
			privateIpFromTask(
				{
					containers: [{ name: DEFAULT_CONTAINER_NAME }],
					attachments: [
						{
							type: 'ElasticNetworkInterface',
							details: [{ name: 'privateIPv4Address', value: '10.0.0.42' }],
						},
					],
				},
				DEFAULT_CONTAINER_NAME,
			),
		).toBe('10.0.0.42');
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
			overrides: { cpu: '1024', memory: '4096' },
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

	it('retries eventually consistent task descriptions before readiness', async () => {
		const client = new FakeEcs();
		client.invisibleDescribes = 2;
		const instance = makeCompute(client).create(ID, { reuse: false });
		await expect(instance.ready?.()).resolves.toBeUndefined();
		expect(client.describeCalls).toBeGreaterThan(2);
	});

	it('retries transient DescribeTasks failures before readiness', async () => {
		const client = new FakeEcs();
		client.describeFailures = 2;
		const instance = makeCompute(client).create(ID, { reuse: false });
		await expect(instance.ready?.()).resolves.toBeUndefined();
	});

	it('retries DescribeTasks transport errors before readiness', async () => {
		const client = new FakeEcs();
		client.describeThrows = 2;
		const instance = makeCompute(client).create(ID, { reuse: false });
		await expect(instance.ready?.()).resolves.toBeUndefined();
	});

	it('bounds a blackholed health probe by the overall readiness deadline', async () => {
		const client = new FakeEcs();
		client.describeDelayMs = 150;
		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const signal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => {
					const reason = signal?.reason;
					reject(reason instanceof Error ? reason : new Error('health probe aborted'));
				};
				if (signal?.aborted) abort();
				else signal?.addEventListener('abort', abort, { once: true });
			});
		});
		const instance = makeCompute(client, { readyTimeoutMs: 200 }).create(ID, { reuse: false });
		const started = Date.now();
		await expect(instance.ready?.()).rejects.toThrow(/Timed out waiting/);
		expect(Date.now() - started).toBeLessThan(300);
	});

	it('reports a task that stops before agent readiness', async () => {
		const client = new FakeEcs();
		client.stopBeforeReady = true;
		const instance = makeCompute(client).create(ID, { reuse: false });
		await expect(instance.ready?.()).rejects.toThrow(/stopped before readiness/);
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
			containers: [{ name: 'marimo' }],
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

	it('paginates ListTasks and batches DescribeTasks requests', async () => {
		const client = new FakeEcs();
		client.listPageSize = 60;
		for (let index = 0; index < 101; index++) {
			const id = `sb-${index.toString(16).padStart(16, '0')}`;
			client.tasks.set(`task-${index}`, {
				taskArn: `task-${index}`,
				lastStatus: 'RUNNING',
				containers: [{ name: 'marimo' }],
				attachments: [
					{ type: 'eni', details: [{ name: 'privateIPv4Address', value: '10.0.0.9' }] },
				],
				tags: [
					{ key: OWNER_TAG, value: 'deployment-a' },
					{ key: SANDBOX_ID_TAG, value: id },
				],
			});
		}
		expect(await makeCompute(client).listActive()).toHaveLength(101);
		expect(client.listCalls).toBe(2);
		expect(client.describeCalls).toBe(2);
	});

	it('ignores malformed foreign tags while retaining exact ownership', async () => {
		const client = new FakeEcs();
		client.tasks.set('malformed', {
			taskArn: 'malformed',
			lastStatus: 'RUNNING',
			containers: [{ name: 'marimo' }],
			tags: [
				{ value: 'missing-key' },
				{ key: 'foreign' },
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
			],
		});
		expect(await makeCompute(client).listActive()).toEqual([
			expect.objectContaining({ id: ID, taskArn: 'malformed' }),
		]);
	});

	it('rejects duplicate live tasks for one sandbox', async () => {
		const client = new FakeEcs();
		for (const arn of ['one', 'two']) {
			client.tasks.set(arn, {
				taskArn: arn,
				lastStatus: 'RUNNING',
				containers: [{ name: 'marimo' }],
				tags: [
					{ key: OWNER_TAG, value: 'deployment-a' },
					{ key: SANDBOX_ID_TAG, value: ID },
				],
			});
		}
		await expect(makeCompute(client).listActive()).rejects.toThrow(/Multiple live ECS tasks/);
	});

	it('requires the configured container when reconnecting', async () => {
		const client = new FakeEcs();
		client.tasks.set('wrong-container', {
			taskArn: 'wrong-container',
			lastStatus: 'RUNNING',
			containers: [{ name: 'other' }],
			tags: [
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
			],
		});
		await expect(makeCompute(client).create(ID).ready?.()).rejects.toThrow(
			/configured container marimo/,
		);
	});

	it('hydrates the cache from listActive and avoids rescans until teardown', async () => {
		const client = new FakeEcs();
		client.tasks.set('owned', {
			taskArn: 'owned',
			lastStatus: 'RUNNING',
			desiredStatus: 'RUNNING',
			containers: [{ name: 'marimo' }],
			attachments: [{ type: 'eni', details: [{ name: 'privateIPv4Address', value: '10.0.0.10' }] }],
			tags: [
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
				{ key: IMAGE_KEY_TAG, value: 'default' },
			],
		});
		const compute = makeCompute(client);
		await compute.listActive();
		const first = compute.create(ID);
		await first.destroy();
		const second = compute.create(ID);
		await second.ready?.();
		expect(client.listCalls).toBe(2);
	});

	it('treats duplicate live ownership tags as an unsafe reconciliation state', async () => {
		const client = new FakeEcs();
		client.tasks.set('duplicate', {
			taskArn: 'duplicate',
			lastStatus: 'RUNNING',
			containers: [{ name: 'marimo' }],
			tags: [
				{ key: OWNER_TAG, value: 'deployment-a' },
				{ key: SANDBOX_ID_TAG, value: ID },
				{ key: SANDBOX_ID_TAG, value: ID },
			],
		});
		await expect(makeCompute(client).listActive()).rejects.toThrow(/duplicate ECS tag/);
	});

	it('fails reconciliation when ECS omits a listed task ARN', async () => {
		const client = new FakeEcs();
		client.tasks.set('listed', {
			taskArn: 'other',
			lastStatus: 'RUNNING',
			tags: [],
		});
		await expect(makeCompute(client).listActive()).rejects.toThrow(/did not return requested/);
	});

	it('accepts an already-stopped task during idempotent teardown', async () => {
		const client = new FakeEcs();
		const instance = makeCompute(client).create(ID, { reuse: false });
		await instance.ready?.();
		const arn = client.runInputs.length === 1 ? [...client.tasks.keys()][0] : undefined;
		if (arn) client.tasks.delete(arn);
		await expect(instance.destroy()).resolves.toBeUndefined();
	});
});

describe('agent token derivation', () => {
	it('is deterministic and per sandbox', () => {
		expect(deriveAgentToken(TOKEN, ID)).toBe(deriveAgentToken(TOKEN, ID));
		expect(deriveAgentToken(TOKEN, ID)).not.toBe(deriveAgentToken(TOKEN, 'sb-bbbbbbbbbbbbbbbb'));
	});
});

class ContractWorld {
	readonly client = new FakeEcs();
	private readonly files = new Map<string, Uint8Array>();
	private readonly environment = new Map<string, string>();
	private readonly processes = new Map<
		string,
		{ stdout: string; stderr: string; portOpen: boolean }
	>();
	private processSequence = 0;

	private response(payload: Record<string, unknown>, status = 200): Response {
		return Response.json(payload, { status });
	}

	async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		const request = new URL(url);
		const method = init.method ?? 'GET';
		if (method === 'GET' && request.pathname === '/health') {
			return this.response({ ok: true, protocolVersion: FARGATE_PROTOCOL_VERSION });
		}
		if (method === 'POST' && request.pathname === '/files/write') {
			const payload = JSON.parse(String(init.body)) as { files?: unknown };
			for (const value of payload.files as { path: string; contentBase64: string }[]) {
				this.files.set(value.path, Uint8Array.from(Buffer.from(value.contentBase64, 'base64')));
			}
			return this.response({ written: (payload.files as unknown[]).length });
		}
		if (method === 'GET' && request.pathname === '/files/read') {
			const path = request.searchParams.get('path') ?? '';
			const content = this.files.get(path);
			if (!content) return this.response({ error: 'file not found' }, 404);
			return this.response({ contentBase64: Buffer.from(content).toString('base64') });
		}
		if (method === 'POST' && request.pathname === '/env') {
			const payload = JSON.parse(String(init.body)) as {
				forced?: Record<string, string>;
				defaults?: Record<string, string>;
			};
			for (const [key, value] of Object.entries(payload.defaults ?? {})) {
				if (!this.environment.has(key)) this.environment.set(key, value);
			}
			for (const [key, value] of Object.entries(payload.forced ?? {})) {
				this.environment.set(key, value);
			}
			return this.response({ ok: true });
		}
		if (method === 'POST' && request.pathname === '/exec') {
			const payload = JSON.parse(String(init.body)) as {
				command?: string;
				env?: Record<string, string>;
			};
			const command = payload.command ?? '';
			if (isContractNonDirectoryFindCommand(command)) {
				return this.response({
					success: false,
					exitCode: 20,
					stdout: '',
					stderr: 'MARIMOHUB_NOT_A_DIRECTORY\n',
				});
			}
			if (command.includes('find ')) {
				const recursive = !command.includes('-maxdepth 1');
				const output: string[] = [];
				for (const [path, content] of this.files) {
					if (!path.startsWith('/workspace/') || path === '/workspace/') continue;
					const relative = path.slice('/workspace/'.length);
					if (!recursive && relative.includes('/')) continue;
					output.push(`f\t${content.byteLength}\t${path}\0`);
				}
				return this.response({ success: true, exitCode: 0, stdout: output.join(''), stderr: '' });
			}
			if (command.includes('mh-contract-fail') || command.trim() === 'false') {
				return this.response({ success: false, exitCode: 1, stdout: '', stderr: 'failed' });
			}
			const envMatch = command.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/);
			return this.response({
				success: true,
				exitCode: 0,
				stdout: envMatch
					? (this.environment.get(envMatch[1]) ?? payload.env?.[envMatch[1]] ?? '')
					: '',
				stderr: '',
			});
		}
		if (method === 'POST' && request.pathname === '/processes') {
			const payload = JSON.parse(String(init.body)) as { command?: string };
			const script = scriptContractLaunch(payload.command);
			const id = `contract-process-${++this.processSequence}`;
			this.processes.set(id, {
				stdout: script?.transcript ?? '',
				stderr: '',
				portOpen: script?.portOpen ?? false,
			});
			return this.response({ id }, 201);
		}
		const processMatch = request.pathname.match(/^\/processes\/([^/]+)(?:\/(.*))?$/);
		if (processMatch) {
			const process = this.processes.get(decodeURIComponent(processMatch[1]));
			if (!process) return this.response({ error: 'process not found' }, 404);
			const action = processMatch[2];
			if (method === 'POST' && action === 'wait-port') {
				return process.portOpen
					? this.response({ ready: true })
					: this.response({ error: 'timed out waiting for port' }, 408);
			}
			if (method === 'GET' && action === 'logs') {
				return this.response({ stdout: process.stdout, stderr: process.stderr });
			}
			if (method === 'DELETE' && !action) {
				this.processes.delete(decodeURIComponent(processMatch[1]));
				return new Response(null, { status: 204 });
			}
		}
		return this.response({ error: 'route not found' }, 404);
	}
}

computeContract(
	'FargateCompute',
	() => {
		const world = new ContractWorld();
		activeContractWorld = world;
		return new FargateCompute({
			cluster: 'marimo',
			taskDefinition: 'family:7',
			subnets: ['subnet-a'],
			securityGroups: ['sg-hub'],
			owner: 'deployment-a',
			agentSecret: TOKEN,
			exposureMode: 'proxy',
			client: world.client,
			resolver: {
				async resolve(imageKey) {
					return {
						taskDefinition: 'family:7',
						containerName: 'marimo',
						imageKey: imageKey ?? 'default',
					};
				},
			},
		});
	},
	{
		mountFallsBack: true,
		semantics: {
			failingCommand: 'mh-contract-fail',
			absentFile: { path: '/workspace/contract-absent.txt', code: 'NOT_FOUND' },
			envProbe: (name) => `printf '%s' "$${name}"`,
			hiddenFiles: {
				dir: '/workspace',
				seed: (inst) =>
					inst.writeFiles([
						{ path: `/workspace/${CONTRACT_VISIBLE_FILE}`, content: 'v' },
						{ path: `/workspace/${CONTRACT_HIDDEN_FILE}`, content: 'h' },
					]),
			},
			launch: {},
		},
	},
);
