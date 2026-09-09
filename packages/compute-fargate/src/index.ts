import { randomUUID } from 'node:crypto';
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
	FargateCreateOptions,
	FargateFailure,
	FargateRunTaskInput,
	FargateTask,
	FargateTaskDefinition,
	FargateTaskDefinitionResolver,
	FargateTaskHandle,
} from './shared';
import {
	AGENT_TRANSPORT_GRACE_MS,
	AGENT_HEALTH_TIMEOUT_MS,
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
	MAX_AGENT_BODY_BYTES,
	MAX_FILE_BYTES,
	MAX_WRITE_BATCH_BYTES,
	OWNER_TAG,
	privateIpFromTask,
	SANDBOX_ID_TAG,
	tagValues,
	tagMap,
	taskDiagnostic,
	validateFargateOwner,
	validateFargateTaskDefinition,
} from './shared';

export * from './shared';
export { createFargateClient } from './client';
export type { AwsFargateClientOptions } from './client';

const POLL_BASE_INTERVAL_MS = 100;
const POLL_MAX_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function pollDelay(attempt: number): number {
	const ceiling = Math.min(POLL_MAX_INTERVAL_MS, POLL_BASE_INTERVAL_MS * 2 ** attempt);
	return Math.max(25, Math.floor(ceiling * (0.75 + Math.random() * 0.5)));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const value = error as {
		name?: unknown;
		message?: unknown;
		statusCode?: unknown;
		$metadata?: { httpStatusCode?: number };
	};
	return (
		value.name === 'ResourceNotFoundException' ||
		value.name === 'NotFound' ||
		(value.name === 'ClientException' &&
			typeof value.message === 'string' &&
			/(?:not found|does not exist|already stopped|is stopped)/i.test(value.message)) ||
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

class AgentProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentProtocolError';
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

function agentJsonBody(value: unknown): string {
	const body = JSON.stringify(value);
	if (body === undefined) throw new Error('Fargate agent request body is not JSON serializable');
	if (Buffer.byteLength(body, 'utf8') > MAX_AGENT_BODY_BYTES) {
		throw new Error('Fargate agent request exceeds the body limit');
	}
	return body;
}

interface FargateSandboxOptions {
	resources?: ComputeResources;
	reuse: boolean;
	imageKey?: string;
}

type FargateTaskCache = Map<string, FargateTaskHandle>;
type FargateTaskDefinitionCheck = (taskDefinition: string, containerName: string) => Promise<void>;

function assertTaskDefinition(definition: FargateTaskDefinition, containerName: string): void {
	if (!definition.containerNames?.includes(containerName)) {
		throw new Error(`Fargate task definition does not contain container ${containerName}`);
	}
	if (definition.networkMode !== 'awsvpc') {
		throw new Error('Fargate task definition must use awsvpc network mode');
	}
	if (!definition.requiresCompatibilities?.includes('FARGATE')) {
		throw new Error('Fargate task definition must require FARGATE compatibility');
	}
	if (!definition.taskRoleArn) {
		throw new Error('Fargate task definition must define a task role');
	}
	if (definition.staticCredentialContainers?.includes(containerName)) {
		throw new Error(
			`Fargate container ${containerName} must use its task role instead of static AWS access keys`,
		);
	}
}

async function findOwnedTasks(
	client: FargateClient,
	config: FargateConfig,
	sandboxId?: SandboxId,
): Promise<FargateTask[]> {
	const arns: string[] = [];
	const seenArns = new Set<string>();
	let nextToken: string | undefined;
	do {
		const page = await client.listTasks(config.cluster, config.owner, nextToken);
		for (const arn of page.taskArns ?? []) {
			if (!seenArns.has(arn)) {
				seenArns.add(arn);
				arns.push(arn);
			}
		}
		nextToken = page.nextToken;
	} while (nextToken);
	const tasks: FargateTask[] = [];
	for (let offset = 0; offset < arns.length; offset += 100) {
		const requested = arns.slice(offset, offset + 100);
		const described = await client.describeTasks(config.cluster, requested, true);
		if (described.failures && described.failures.length > 0) {
			throw new Error(
				`ECS DescribeTasks failed for owned tasks: ${failureMessage(described.failures)}`,
			);
		}
		const returned = new Set((described.tasks ?? []).map((task) => task.taskArn).filter(Boolean));
		const missing = requested.filter((arn) => !returned.has(arn));
		if (missing.length > 0) {
			throw new Error(
				`ECS DescribeTasks did not return requested task ARN${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`,
			);
		}
		for (const task of described.tasks ?? []) {
			if (!isLiveTask(task)) continue;
			const ownerValues = tagValues(task.tags, OWNER_TAG);
			if (ownerValues.length !== 1 || ownerValues[0] !== config.owner) continue;
			const tags = tagMap(task.tags);
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
	private ensurePromise?: Promise<void>;
	private handle?: FargateTaskHandle;
	private timings: { create?: number; boot?: number } = {};
	private readonly clientToken: string;

	constructor(
		private readonly id: SandboxId,
		private readonly config: FargateConfig,
		private readonly client: FargateClient,
		private readonly resolver: FargateTaskDefinitionResolver,
		private readonly checkTaskDefinition: FargateTaskDefinitionCheck,
		private readonly options: FargateSandboxOptions,
		private readonly cache: FargateTaskCache,
	) {
		this.agentPort = config.agentPort ?? DEFAULT_AGENT_PORT;
		this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.clientToken = deterministicClientToken(config.owner, String(id), randomUUID());
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
		let reconnecting = false;
		let containerName = this.config.containerName ?? DEFAULT_CONTAINER_NAME;
		let imageKey = this.options.imageKey ?? this.config.imageKey ?? DEFAULT_IMAGE_KEY;
		if (this.options.reuse) {
			const cached = this.cache.get(String(this.id));
			if (cached) {
				try {
					await this.checkAgent(
						cached.privateIp,
						Math.max(1, Math.min(AGENT_HEALTH_TIMEOUT_MS, this.readyTimeoutMs / 2)),
					);
					this.handle = cached;
					this.timings = { create: Date.now() - started, boot: 0 };
					return;
				} catch (error) {
					if (error instanceof AgentProtocolError) throw error;
					this.cache.delete(String(this.id));
				}
			}
		}
		if (this.options.reuse) {
			const matches = await this.findOwnedTasks(this.id);
			if (matches.length > 1) {
				throw new Error(
					`Multiple live ECS tasks found for sandbox ${this.id}; refusing to choose one`,
				);
			}
			task = matches[0];
			reconnecting = task !== undefined;
			if (task) imageKey = tagMap(task.tags).get(IMAGE_KEY_TAG) ?? imageKey;
		}
		if (!task) {
			const resolved = await this.resolver.resolve(this.options.imageKey ?? this.config.imageKey);
			containerName = resolved.containerName;
			imageKey = resolved.imageKey;
			await this.checkTaskDefinition(resolved.taskDefinition, containerName);
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
				clientToken: this.clientToken,
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
		if (reconnecting) {
			containerName = this.resolveContainerName(task);
			await this.checkTaskDefinition(
				task.taskDefinitionArn ?? this.config.taskDefinition,
				containerName,
			);
		}
		const createFinished = Date.now();
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
		this.cache.set(String(this.id), this.handle);
		this.timings = { create: createFinished - started, boot: Date.now() - createFinished };
	}

	private resolveContainerName(task: FargateTask): string {
		const configured = this.config.containerName ?? DEFAULT_CONTAINER_NAME;
		if (task.containers?.some((container) => container.name === configured)) return configured;
		if (task.containers) {
			throw new Error(
				`Fargate task ${task.taskArn ?? 'unknown'} does not contain configured container ${configured}`,
			);
		}
		return configured;
	}

	private async findOwnedTasks(sandboxId?: SandboxId): Promise<FargateTask[]> {
		return findOwnedTasks(this.client, this.config, sandboxId);
	}

	private async waitForTask(arn: string, containerName: string): Promise<FargateTask> {
		const deadline = Date.now() + this.readyTimeoutMs;
		let last: FargateTask | undefined;
		let lastFailure: string | undefined;
		let attempt = 0;
		while (Date.now() < deadline) {
			let described: Awaited<ReturnType<FargateClient['describeTasks']>>;
			try {
				described = await this.client.describeTasks(this.config.cluster, [arn], true);
			} catch (error) {
				lastFailure = errorMessage(error);
				await sleep(Math.min(pollDelay(attempt++), Math.max(1, deadline - Date.now())));
				continue;
			}
			if (described.failures && described.failures.length > 0) {
				lastFailure = failureMessage(described.failures);
				await sleep(Math.min(pollDelay(attempt++), Math.max(1, deadline - Date.now())));
				continue;
			}
			last = described.tasks?.find((candidate) => candidate.taskArn === arn);
			if (!last) {
				lastFailure = 'task was not returned by ECS';
				await sleep(Math.min(pollDelay(attempt++), Math.max(1, deadline - Date.now())));
				continue;
			}
			if (last.lastStatus === 'STOPPED') {
				throw new Error(`Fargate task ${arn} stopped before readiness: ${taskDiagnostic(last)}`);
			}
			const ip = privateIpFromTask(last, containerName);
			if (last.lastStatus === 'RUNNING' && ip) {
				try {
					const remaining = Math.max(1, deadline - Date.now());
					await this.checkAgent(ip, Math.min(AGENT_HEALTH_TIMEOUT_MS, remaining));
					return last;
				} catch (error) {
					if (error instanceof AgentProtocolError) throw error;
					if (error instanceof AgentHttpError && error.status >= 400 && error.status < 500)
						throw error;
				}
			}
			await sleep(Math.min(pollDelay(attempt++), Math.max(1, deadline - Date.now())));
		}
		throw new Error(
			`Timed out waiting for Fargate task ${arn} and agent after ${this.readyTimeoutMs}ms${last ? ` (${taskDiagnostic(last)})` : ` (${lastFailure ?? 'task was not returned by ECS'})`}`,
		);
	}

	private async checkAgent(privateIp: string, timeoutMs: number): Promise<void> {
		const body = asJsonRecord(
			await this.requestAt(privateIp, '/health', { method: 'GET' }, true, timeoutMs, 0),
		);
		const protocol = body.protocolVersion ?? body.version;
		if (protocol !== FARGATE_PROTOCOL_VERSION && protocol !== `v${FARGATE_PROTOCOL_VERSION}`) {
			throw new AgentProtocolError(
				`Fargate sandbox agent protocol ${String(protocol)} is incompatible with hub protocol ${FARGATE_PROTOCOL_VERSION}`,
			);
		}
	}

	private async request<T>(
		path: string,
		init: RequestInit = {},
		parse = true,
		requestedTimeoutMs?: number,
	): Promise<T> {
		await this.ensure();
		return this.requestAt(
			this.handle!.privateIp,
			path,
			init,
			parse,
			requestedTimeoutMs,
		) as Promise<T>;
	}

	private async requestAt<T>(
		privateIp: string,
		path: string,
		init: RequestInit = {},
		parse = true,
		requestedTimeoutMs?: number,
		transportGraceMs = AGENT_TRANSPORT_GRACE_MS,
	): Promise<T> {
		const token = deriveAgentToken(this.config.agentSecret, String(this.id));
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${token}`);
		if (init.body !== undefined && !headers.has('content-type'))
			headers.set('content-type', 'application/json');
		const transportTimeoutMs =
			requestedTimeoutMs === undefined
				? this.readyTimeoutMs
				: requestedTimeoutMs === 0 || requestedTimeoutMs === Infinity
					? 0
					: requestedTimeoutMs + transportGraceMs;
		const requestInit: RequestInit = {
			...init,
			headers,
		};
		if (transportTimeoutMs > 0 && Number.isFinite(transportTimeoutMs)) {
			requestInit.signal = AbortSignal.timeout(transportTimeoutMs);
		}
		const response = await fetch(`http://${privateIp}:${this.agentPort}${path}`, requestInit);
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
			const requestedTimeout = options?.timeout === Infinity ? 0 : options?.timeout;
			const body = asJsonRecord(
				await this.request(
					'/exec',
					{
						method: 'POST',
						body: agentJsonBody({
							command: cmd,
							cwd: '/workspace',
							env: this.commandEnv(),
							timeoutMs: requestedTimeout,
						}),
					},
					true,
					requestedTimeout,
				),
			);
			return execResult(body.success === true, textValue(body.stdout), textValue(body.stderr));
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
			if (bytes.byteLength > MAX_FILE_BYTES)
				throw new Error(`file ${file.path} exceeds the Fargate file limit`);
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
				body: agentJsonBody({
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
		const defaults = options?.onlyIfUnset ? vars : {};
		const forced = options?.onlyIfUnset ? {} : vars;
		await this.request('/env', {
			method: 'POST',
			body: agentJsonBody({ forced, defaults }),
		});
		Object.assign(this.env, forced);
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
				body: agentJsonBody({
					command: cmd,
					processId: options?.processId,
					cwd: options?.cwd ?? '/workspace',
					env: this.commandEnv(options?.env),
					timeoutMs: options?.timeout === Infinity ? 0 : options?.timeout,
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
				const requestedTimeout = waitOptions?.timeout === Infinity ? 0 : waitOptions?.timeout;
				await this.request(
					`${path}/wait-port`,
					{
						method: 'POST',
						body: agentJsonBody({
							port,
							mode: waitOptions?.mode ?? 'tcp',
							path: waitOptions?.path,
							timeoutMs: requestedTimeout,
						}),
					},
					true,
					requestedTimeout,
				);
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
			this.handle = this.cache.get(String(this.id));
		}
		if (!this.handle) {
			const matches = await this.findOwnedTasks(this.id);
			if (matches.length > 1)
				throw new Error(
					`Multiple live ECS tasks found for sandbox ${this.id}; refusing to stop one`,
				);
			if (matches[0])
				this.handle = {
					taskArn: taskArn(matches[0]),
					containerName: this.resolveContainerName(matches[0]),
					privateIp:
						privateIpFromTask(matches[0], this.config.containerName ?? DEFAULT_CONTAINER_NAME) ??
						'',
					taskDefinitionArn: matches[0].taskDefinitionArn,
					createdAt: matches[0].createdAt,
					imageKey: tagMap(matches[0].tags).get(IMAGE_KEY_TAG) ?? DEFAULT_IMAGE_KEY,
				};
			if (this.handle) this.cache.set(String(this.id), this.handle);
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
			this.cache.delete(String(this.id));
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
	private readonly cache: FargateTaskCache = new Map();
	private readonly checkedTaskDefinitions = new Set<string>();

	constructor(options: FargateComputeOptions) {
		if (options.exposureMode !== undefined && options.exposureMode !== 'proxy') {
			throw new Error('Fargate compute supports MARIMOHUB_SANDBOX_EXPOSURE=proxy only');
		}
		if (options.subnets.length === 0 || options.securityGroups.length === 0) {
			throw new Error('Fargate compute requires at least one subnet and security group');
		}
		this.config = {
			...options,
			taskDefinition: validateFargateTaskDefinition(options.taskDefinition),
			owner: validateFargateOwner(options.owner),
			agentSecret: options.agentSecret,
		};
		deriveAgentToken(this.config.agentSecret, 'validation');
		this.client = options.client ?? createFargateClient();
		this.resolver = options.resolver ?? defaultResolver(this.config);
	}

	create(id: SandboxId, options?: FargateCreateOptions): SandboxInstance {
		return new FargateSandboxInstance(
			id,
			this.config,
			this.client,
			this.resolver,
			(taskDefinition, containerName) => this.checkTaskDefinition(taskDefinition, containerName),
			{
				reuse: options?.reuse ?? true,
				resources: options?.resources,
				imageKey: options?.image,
			},
			this.cache,
		);
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
			const containerName = this.config.containerName ?? DEFAULT_CONTAINER_NAME;
			if (!task.containers?.some((container) => container.name === containerName)) {
				throw new Error(
					`Fargate task ${task.taskArn ?? 'unknown'} does not contain configured container ${containerName}`,
				);
			}
			const arn = taskArn(task);
			const privateIp = privateIpFromTask(task, containerName);
			if (privateIp) {
				this.cache.set(id, {
					taskArn: arn,
					taskDefinitionArn: task.taskDefinitionArn,
					containerName,
					privateIp,
					createdAt: task.createdAt ?? tagMap(task.tags).get(CREATED_AT_TAG),
					imageKey: tagMap(task.tags).get(IMAGE_KEY_TAG) ?? DEFAULT_IMAGE_KEY,
				});
			}
			active.push({
				id: id as SandboxId,
				createdAt: task.createdAt ?? tagMap(task.tags).get(CREATED_AT_TAG),
				taskArn: arn,
			});
		}
		return active.filter((entry) => entry.taskArn !== undefined);
	}

	async healthCheck(): Promise<void> {
		await this.client.describeCluster(this.config.cluster);
		const containerName = this.config.containerName ?? DEFAULT_CONTAINER_NAME;
		await this.checkTaskDefinition(this.config.taskDefinition, containerName);
	}

	private async checkTaskDefinition(taskDefinition: string, containerName: string): Promise<void> {
		const key = `${taskDefinition}\0${containerName}`;
		if (this.checkedTaskDefinitions.has(key)) return;
		const definition = await this.client.describeTaskDefinition(taskDefinition);
		assertTaskDefinition(definition, containerName);
		this.checkedTaskDefinitions.add(key);
	}
}

export function fargateProfileResourcesForTests(resources: ComputeResources | undefined) {
	return fargateProfileResources(resources);
}
