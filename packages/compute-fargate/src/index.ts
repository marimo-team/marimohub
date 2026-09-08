import {
	buildFindFilesCommand,
	buildGitCloneCommand,
	classifyListFilesFailure,
	launchWithProcess,
	mapWithConcurrency,
	parseFindFilesOutput,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import type {
	ComputeResources,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	GitCheckoutOptions,
	LaunchProcessOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxInstance,
	SandboxLaunchResult,
	SandboxProcess,
	SandboxProvider,
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports';
import type { SandboxId } from '@marimo-hub/core';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports';
import { createFargateClient } from './client';
import type {
	FargateActiveSandbox,
	FargateClient,
	FargateConfig,
	FargateContainer,
	FargateCreateOptions,
	FargateFailure,
	FargateRunTaskInput,
	FargateTask,
	FargateTaskDefinitionResolver,
	FargateTaskHandle,
} from './shared';
import {
	CREATED_AT_TAG,
	DEFAULT_AGENT_PORT,
	DEFAULT_CONTAINER_NAME,
	DEFAULT_IMAGE_KEY,
	DEFAULT_READY_TIMEOUT_MS,
	deriveAgentToken,
	deterministicClientToken,
	FARGATE_PROTOCOL_VERSION,
	fargateProfileResources,
	IMAGE_KEY_TAG,
	isLiveTask,
	MAX_WRITE_BATCH_BYTES,
	OWNER_TAG,
	privateIpFromTask,
	SANDBOX_ID_TAG,
	tagMap,
	taskDiagnostic,
	validateFargateOwner,
} from './shared';

export * from './shared';
export { createFargateClient } from './client';
export type { AwsFargateClientOptions } from './client';

const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const value = error as {
		name?: unknown;
		statusCode?: unknown;
		$metadata?: { httpStatusCode?: number };
	};
	return (
		value.name === 'ResourceNotFoundException' ||
		value.name === 'NotFound' ||
		value.statusCode === 404 ||
		value.$metadata?.httpStatusCode === 404
	);
}

function taskArn(task: FargateTask): string {
	if (!task.taskArn) throw new Error('ECS returned a task without an ARN');
	return task.taskArn;
}

function failureMessage(failures: readonly FargateFailure[] | undefined): string {
	return (
		failures
			?.map((failure) => [failure.reason, failure.detail].filter(Boolean).join(': '))
			.filter(Boolean)
			.join('; ') || 'ECS did not return a task'
	);
}

class AgentHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'AgentHttpError';
	}
}

function asJsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Fargate agent returned an invalid JSON object');
	}
	return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
	if (typeof body[key] !== 'string') throw new Error(`Fargate agent response is missing ${key}`);
	return body[key];
}

function textValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

interface FargateSandboxOptions {
	resources?: ComputeResources;
	reuse: boolean;
	imageKey?: string;
}

async function findOwnedTasks(
	client: FargateClient,
	config: FargateConfig,
	sandboxId?: SandboxId,
): Promise<FargateTask[]> {
	const arns: string[] = [];
	let nextToken: string | undefined;
	do {
		const page = await client.listTasks(config.cluster, config.owner, nextToken);
		arns.push(...(page.taskArns ?? []));
		nextToken = page.nextToken;
	} while (nextToken);
	const tasks: FargateTask[] = [];
	for (let offset = 0; offset < arns.length; offset += 100) {
		const described = await client.describeTasks(
			config.cluster,
			arns.slice(offset, offset + 100),
			true,
		);
		for (const task of described.tasks ?? []) {
			if (!isLiveTask(task)) continue;
			const tags = tagMap(task.tags);
			if (tags.get(OWNER_TAG) !== config.owner) continue;
			if (sandboxId !== undefined && tags.get(SANDBOX_ID_TAG) !== String(sandboxId)) continue;
			tasks.push(task);
		}
	}
	return tasks;
}

class FargateSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private readonly agentPort: number;
	private readonly readyTimeoutMs: number;
	private readonly env: Record<string, string> = {};
	private readonly envDefaults: Record<string, string> = {};
	private ensurePromise?: Promise<void>;
	private handle?: FargateTaskHandle;
	private timings: { create?: number; boot?: number } = {};

	constructor(
		private readonly id: SandboxId,
		private readonly config: FargateConfig,
		private readonly client: FargateClient,
		private readonly resolver: FargateTaskDefinitionResolver,
		private readonly options: FargateSandboxOptions,
	) {
		this.agentPort = config.agentPort ?? DEFAULT_AGENT_PORT;
		this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	}

	private async ensure(): Promise<void> {
		if (this.handle) return;
		this.ensurePromise ??= this.resolveTask().finally(() => {
			this.ensurePromise = undefined;
		});
		await this.ensurePromise;
	}

	private async resolveTask(): Promise<void> {
		const started = Date.now();
		let task: FargateTask | undefined;
		let imageKey = this.options.imageKey ?? this.config.imageKey ?? DEFAULT_IMAGE_KEY;
		if (this.options.reuse) {
			const matches = await this.findOwnedTasks(this.id);
			if (matches.length > 1) {
				throw new Error(
					`Multiple live ECS tasks found for sandbox ${this.id}; refusing to choose one`,
				);
			}
			task = matches[0];
			if (task) imageKey = tagMap(task.tags).get(IMAGE_KEY_TAG) ?? imageKey;
		}
		if (!task) {
			const resolved = await this.resolver.resolve(this.options.imageKey ?? this.config.imageKey);
			imageKey = resolved.imageKey;
			const token = deriveAgentToken(this.config.agentSecret, String(this.id));
			const resources = fargateProfileResources(this.options.resources);
			const now = new Date().toISOString();
			const overrides = {
				...(resources ? { cpu: resources.cpu, memory: resources.memory } : {}),
				containerOverrides: [
					{
						name: resolved.containerName,
						environment: [
							{ name: 'MARIMOHUB_AGENT_TOKEN', value: token },
							{ name: 'MARIMOHUB_AGENT_PORT', value: String(this.agentPort) },
						],
					},
				],
			};
			const input: FargateRunTaskInput = {
				cluster: this.config.cluster,
				taskDefinition: resolved.taskDefinition,
				startedBy: this.config.owner,
				clientToken: deterministicClientToken(this.config.owner, String(this.id)),
				platformVersion: this.config.platformVersion ?? 'LATEST',
				count: 1,
				networkConfiguration: {
					subnets: this.config.subnets,
					securityGroups: this.config.securityGroups,
					assignPublicIp: this.config.assignPublicIp ?? false,
				},
				tags: [
					{ key: OWNER_TAG, value: this.config.owner },
					{ key: SANDBOX_ID_TAG, value: String(this.id) },
					{ key: IMAGE_KEY_TAG, value: imageKey },
					{ key: CREATED_AT_TAG, value: now },
				],
				overrides,
			};
			const result = await this.client.runTask(input);
			if (!result.tasks?.[0])
				throw new Error(
					`Could not start Fargate sandbox ${this.id}: ${failureMessage(result.failures)}`,
				);
			task = result.tasks[0];
		}
		const arn = taskArn(task);
		const containerName = await this.resolveContainerName(task);
		const readyTask = await this.waitForTask(arn, containerName);
		const privateIp = privateIpFromTask(readyTask, containerName);
		if (!privateIp) throw new Error(`Fargate task ${arn} has no private ENI address`);
		this.handle = {
			taskArn: arn,
			taskDefinitionArn: readyTask.taskDefinitionArn,
			containerName,
			privateIp,
			createdAt: readyTask.createdAt ?? tagMap(readyTask.tags).get(CREATED_AT_TAG),
			imageKey,
		};
		this.timings = { create: Date.now() - started, boot: Date.now() - started };
	}

	private async resolveContainerName(task: FargateTask): Promise<string> {
		const configured = this.config.containerName ?? DEFAULT_CONTAINER_NAME;
		if (task.containers?.some((container) => container.name === configured)) return configured;
		const first = task.containers?.find(
			(container): container is FargateContainer & { name: string } => Boolean(container.name),
		)?.name;
		return first ?? configured;
	}

	private async findOwnedTasks(sandboxId?: SandboxId): Promise<FargateTask[]> {
		return findOwnedTasks(this.client, this.config, sandboxId);
	}

	private async waitForTask(arn: string, containerName: string): Promise<FargateTask> {
		const deadline = Date.now() + this.readyTimeoutMs;
		let last: FargateTask | undefined;
		while (Date.now() < deadline) {
			const described = await this.client.describeTasks(this.config.cluster, [arn], true);
			last = described.tasks?.[0];
			if (!last) throw new Error(`Fargate task ${arn} disappeared while starting`);
			if (last.lastStatus === 'STOPPED') {
				throw new Error(`Fargate task ${arn} stopped before readiness: ${taskDiagnostic(last)}`);
			}
			const ip = privateIpFromTask(last, containerName);
			if (last.lastStatus === 'RUNNING' && ip) {
				try {
					await this.checkAgent(ip);
					return last;
				} catch (error) {
					if (error instanceof AgentHttpError && error.status >= 400 && error.status < 500)
						throw error;
				}
			}
			await sleep(POLL_INTERVAL_MS);
		}
		throw new Error(
			`Timed out waiting for Fargate task ${arn} and agent after ${this.readyTimeoutMs}ms${last ? ` (${taskDiagnostic(last)})` : ''}`,
		);
	}

	private async checkAgent(privateIp: string): Promise<void> {
		const body = asJsonRecord(await this.requestAt(privateIp, '/health', { method: 'GET' }));
		const protocol = body.protocolVersion ?? body.version;
		if (protocol !== FARGATE_PROTOCOL_VERSION && protocol !== `v${FARGATE_PROTOCOL_VERSION}`) {
			throw new Error(
				`Fargate sandbox agent protocol ${String(protocol)} is incompatible with hub protocol ${FARGATE_PROTOCOL_VERSION}`,
			);
		}
	}

	private async request<T>(path: string, init: RequestInit = {}, parse = true): Promise<T> {
		await this.ensure();
		return this.requestAt(this.handle!.privateIp, path, init, parse) as Promise<T>;
	}

	private async requestAt<T>(
		privateIp: string,
		path: string,
		init: RequestInit = {},
		parse = true,
	): Promise<T> {
		const token = deriveAgentToken(this.config.agentSecret, String(this.id));
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${token}`);
		if (init.body !== undefined && !headers.has('content-type'))
			headers.set('content-type', 'application/json');
		const response = await fetch(`http://${privateIp}:${this.agentPort}${path}`, {
			...init,
			headers,
			signal: AbortSignal.timeout(this.readyTimeoutMs),
		});
		if (!response.ok)
			throw new AgentHttpError(response.status, `Fargate agent returned HTTP ${response.status}`);
		if (!parse) return undefined as T;
		return (await response.json()) as T;
	}

	private commandEnv(extra?: Record<string, string | undefined>): Record<string, string> {
		const extras: Record<string, string> = {};
		for (const [key, value] of Object.entries(extra ?? {})) {
			if (value !== undefined) extras[key] = value;
		}
		const merged: Record<string, string> = {
			...this.envDefaults,
			...this.env,
			...extras,
		};
		return merged;
	}

	async ready(): Promise<void> {
		await this.ensure();
	}

	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		try {
			const body = asJsonRecord(
				await this.request('/exec', {
					method: 'POST',
					body: JSON.stringify({
						command: cmd,
						cwd: '/workspace',
						env: this.commandEnv(),
						timeoutMs: options?.timeout,
					}),
				}),
			);
			return execResult(
				body.success === true || body.exitCode === 0,
				textValue(body.stdout),
				textValue(body.stderr),
			);
		} catch (error) {
			return execResult(false, '', errorMessage(error), 'BACKEND_ERROR');
		}
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		const result = await this.exec(cmd, options);
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(result.stdout));
				controller.close();
			},
		});
	}

	async readFile(path: string): Promise<ReadFileResult> {
		try {
			const body = asJsonRecord(
				await this.request(`/files/read?path=${encodeURIComponent(path)}`, { method: 'GET' }),
			);
			const encoded = body.contentBase64;
			if (typeof encoded !== 'string') return readFileFailure('READ_FAILED');
			const bytes = Buffer.from(encoded, 'base64');
			const text = bytes.toString('utf8');
			const roundTrip = Buffer.from(text, 'utf8');
			return roundTrip.equals(bytes)
				? { success: true, content: text, encoding: 'utf-8' }
				: { success: true, content: encoded, encoding: 'base64' };
		} catch (error) {
			return readFileFailure(
				error instanceof AgentHttpError && error.status === 404 ? 'NOT_FOUND' : 'BACKEND_ERROR',
			);
		}
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const batches: SandboxFileWrite[][] = [];
		let batch: SandboxFileWrite[] = [];
		let size = 0;
		for (const file of files) {
			const bytes =
				typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
			if (bytes.byteLength > MAX_WRITE_BATCH_BYTES)
				throw new Error(`file ${file.path} exceeds the Fargate write limit`);
			if (batch.length > 0 && size + bytes.byteLength > MAX_WRITE_BATCH_BYTES) {
				batches.push(batch);
				batch = [];
				size = 0;
			}
			batch.push({ path: file.path, content: bytes });
			size += bytes.byteLength;
		}
		if (batch.length > 0) batches.push(batch);
		await mapWithConcurrency(batches, WRITE_CONCURRENCY, async (group) => {
			await this.request('/files/write', {
				method: 'POST',
				body: JSON.stringify({
					files: group.map((file) => ({
						path: file.path,
						contentBase64: Buffer.from(file.content).toString('base64'),
					})),
				}),
			});
		});
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		try {
			const result = await this.exec(buildFindFilesCommand(path, options));
			if (!result.success) return listFilesFailure(classifyListFilesFailure(result));
			return { success: true, files: parseFindFilesOutput(result.stdout, path, options) };
		} catch {
			return listFilesFailure('BACKEND_ERROR');
		}
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const result = await this.exec(buildGitCloneCommand(repo, options));
		if (!result.success) throw new Error(`git checkout failed: ${result.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		await this.ensure();
		if (options?.onlyIfUnset) Object.assign(this.envDefaults, vars);
		else Object.assign(this.env, vars);
		await this.request('/env', {
			method: 'POST',
			body: JSON.stringify({ forced: this.env, defaults: this.envDefaults }),
		});
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		throw new Error(
			'mountBucket is not supported by the Fargate backend; using file copy fallback',
		);
	}

	async unmountBucket(_mountPath: string): Promise<void> {}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const body = asJsonRecord(
			await this.request('/processes', {
				method: 'POST',
				body: JSON.stringify({
					command: cmd,
					processId: options?.processId,
					cwd: options?.cwd ?? '/workspace',
					env: this.commandEnv(options?.env),
					timeoutMs: options?.timeout,
				}),
			}),
		);
		const processId = stringField(body, 'id');
		const path = `/processes/${encodeURIComponent(processId)}`;
		return {
			id: processId,
			command: cmd,
			kill: async (signal?: string) => {
				try {
					await this.request(
						`${path}?signal=${encodeURIComponent(signal ?? 'TERM')}`,
						{ method: 'DELETE' },
						false,
					);
				} catch (error) {
					if (!(error instanceof AgentHttpError && error.status === 404)) throw error;
				}
			},
			waitForPort: async (port: number, waitOptions?: WaitForPortOptions) => {
				await this.request(`${path}/wait-port`, {
					method: 'POST',
					body: JSON.stringify({
						port,
						mode: waitOptions?.mode ?? 'tcp',
						path: waitOptions?.path,
						timeoutMs: waitOptions?.timeout,
					}),
				});
			},
			getLogs: async () => {
				const logs = asJsonRecord(await this.request(`${path}/logs`, { method: 'GET' }));
				return { stdout: textValue(logs.stdout), stderr: textValue(logs.stderr) };
			},
		};
	}

	async launchProcess(cmd: string, options: LaunchProcessOptions): Promise<SandboxLaunchResult> {
		return launchWithProcess({
			setup: options.setup,
			command: cmd,
			port: options.port,
			startupTimeout: options.startupTimeout,
			waitForPort: options.waitForPort,
			start: (command) =>
				this.startProcess(command, {
					cwd: options.cwd,
					env: options.env,
					processId: options.processId,
				}),
		});
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		await this.ensure();
		if (!Number.isInteger(port) || port < 1 || port > 65_535)
			throw new Error(`invalid port ${port}`);
		return { url: `http://${this.handle!.privateIp}:${port}` };
	}

	async destroy(): Promise<void> {
		if (!this.handle) {
			const matches = await this.findOwnedTasks(this.id);
			if (matches.length > 1)
				throw new Error(
					`Multiple live ECS tasks found for sandbox ${this.id}; refusing to stop one`,
				);
			if (matches[0])
				this.handle = {
					taskArn: taskArn(matches[0]),
					containerName: await this.resolveContainerName(matches[0]),
					privateIp:
						privateIpFromTask(matches[0], this.config.containerName ?? DEFAULT_CONTAINER_NAME) ??
						'',
					createdAt: matches[0].createdAt,
					imageKey: tagMap(matches[0].tags).get(IMAGE_KEY_TAG) ?? DEFAULT_IMAGE_KEY,
				};
		}
		if (!this.handle) return;
		try {
			await this.client.stopTask(
				this.config.cluster,
				this.handle.taskArn,
				'marimohub sandbox teardown',
			);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		} finally {
			this.handle = undefined;
		}
	}

	drainTimings(): { create?: number; boot?: number } {
		const value = this.timings;
		this.timings = {};
		return value;
	}
}

function defaultResolver(config: FargateConfig): FargateTaskDefinitionResolver {
	const imageKey = config.imageKey ?? DEFAULT_IMAGE_KEY;
	return {
		async resolve(requested) {
			if (requested !== undefined && requested !== imageKey && requested !== DEFAULT_IMAGE_KEY) {
				throw new Error(`Fargate image key ${JSON.stringify(requested)} is not configured`);
			}
			return {
				taskDefinition: config.taskDefinition,
				containerName: config.containerName ?? DEFAULT_CONTAINER_NAME,
				imageKey,
			};
		},
	};
}

export interface FargateComputeOptions extends FargateConfig {
	client?: FargateClient;
	resolver?: FargateTaskDefinitionResolver;
}

export class FargateCompute implements SandboxProvider {
	readonly capabilities = { multiPort: true } as const;
	private readonly client: FargateClient;
	private readonly resolver: FargateTaskDefinitionResolver;
	private readonly config: FargateConfig;

	constructor(options: FargateComputeOptions) {
		if (options.exposureMode !== undefined && options.exposureMode !== 'proxy') {
			throw new Error('Fargate compute supports MARIMOHUB_SANDBOX_EXPOSURE=proxy only');
		}
		if (options.subnets.length === 0 || options.securityGroups.length === 0) {
			throw new Error('Fargate compute requires at least one subnet and security group');
		}
		this.config = {
			...options,
			owner: validateFargateOwner(options.owner),
			agentSecret: options.agentSecret,
		};
		deriveAgentToken(this.config.agentSecret, 'validation');
		this.client = options.client ?? createFargateClient();
		this.resolver = options.resolver ?? defaultResolver(this.config);
	}

	create(id: SandboxId, options?: FargateCreateOptions): SandboxInstance {
		return new FargateSandboxInstance(id, this.config, this.client, this.resolver, {
			reuse: options?.reuse ?? true,
			resources: options?.resources,
			imageKey: options?.image,
		});
	}

	async proxy(_request: Request): Promise<Response | null> {
		return null;
	}

	async listActive(): Promise<FargateActiveSandbox[]> {
		const tasks = await findOwnedTasks(this.client, this.config);
		const active: FargateActiveSandbox[] = [];
		const seen = new Set<string>();
		for (const task of tasks.filter((candidate) => candidate.lastStatus === 'RUNNING')) {
			const id = tagMap(task.tags).get(SANDBOX_ID_TAG);
			if (!id || !/^sb-[0-9a-z]{16}$/.test(id)) continue;
			if (seen.has(id)) throw new Error(`Multiple live ECS tasks found for sandbox ${id}`);
			seen.add(id);
			active.push({
				id: id as SandboxId,
				createdAt: task.createdAt ?? tagMap(task.tags).get(CREATED_AT_TAG),
				taskArn: task.taskArn,
			});
		}
		return active.filter((entry) => entry.taskArn !== undefined);
	}

	async healthCheck(): Promise<void> {
		await this.client.describeCluster(this.config.cluster);
		const definition = await this.client.describeTaskDefinition(this.config.taskDefinition);
		const containerName = this.config.containerName ?? DEFAULT_CONTAINER_NAME;
		if (!definition.containerNames?.includes(containerName)) {
			throw new Error(`Fargate task definition does not contain container ${containerName}`);
		}
	}
}

export function fargateProfileResourcesForTests(resources: ComputeResources | undefined) {
	return fargateProfileResources(resources);
}
