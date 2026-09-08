import { createHash, createHmac } from 'node:crypto';
import type {
	ActiveSandbox,
	ComputeResources,
	CreateSandboxOptions,
	SandboxExposureMode,
} from '@marimo-hub/core/ports';

export const FARGATE_PROTOCOL_VERSION = 1;
export const DEFAULT_AGENT_PORT = 2717;
export const DEFAULT_KERNEL_PORT = 2718;
export const DEFAULT_READY_TIMEOUT_MS = 120_000;
export const DEFAULT_CONTAINER_NAME = 'marimo';
export const DEFAULT_IMAGE_KEY = 'default';
export const MAX_AGENT_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WRITE_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;

export const OWNER_TAG = 'marimohub:owner';
export const SANDBOX_ID_TAG = 'marimohub:sandbox-id';
export const IMAGE_KEY_TAG = 'marimohub:image-key';
export const CREATED_AT_TAG = 'marimohub:created-at';

export interface FargateNetworkConfiguration {
	subnets: readonly string[];
	securityGroups: readonly string[];
	assignPublicIp: boolean;
}

export interface FargateContainer {
	name?: string;
	lastStatus?: string;
	exitCode?: number;
	reason?: string;
	networkInterfaces?: readonly { privateIpv4Address?: string }[];
}

export interface FargateTask {
	taskArn?: string;
	taskDefinitionArn?: string;
	lastStatus?: string;
	desiredStatus?: string;
	createdAt?: string;
	startedAt?: string;
	stoppedAt?: string;
	stoppedReason?: string;
	stopCode?: string;
	containers?: readonly FargateContainer[];
	attachments?: readonly {
		type?: string;
		details?: readonly { name?: string; value?: string }[];
	}[];
	tags?: readonly { key?: string; value?: string }[];
}

export interface FargateTaskDefinition {
	taskDefinitionArn?: string;
	family?: string;
	revision?: number;
	containerNames?: readonly string[];
}

export interface FargateRunTaskInput {
	cluster: string;
	taskDefinition: string;
	startedBy: string;
	clientToken: string;
	platformVersion: string;
	count: 1;
	networkConfiguration: FargateNetworkConfiguration;
	tags: readonly { key: string; value: string }[];
	overrides?: {
		cpu?: string;
		memory?: string;
		containerOverrides?: readonly {
			name: string;
			environment: readonly { name: string; value: string }[];
		}[];
	};
}

export interface FargateClient {
	runTask(
		input: FargateRunTaskInput,
	): Promise<{ tasks?: readonly FargateTask[]; failures?: readonly FargateFailure[] }>;
	describeTasks(
		cluster: string,
		taskArns: readonly string[],
		includeTags?: boolean,
	): Promise<{ tasks?: readonly FargateTask[]; failures?: readonly FargateFailure[] }>;
	listTasks(
		cluster: string,
		startedBy: string,
		nextToken?: string,
	): Promise<{ taskArns?: readonly string[]; nextToken?: string }>;
	stopTask(cluster: string, task: string, reason: string): Promise<void>;
	describeTaskDefinition(taskDefinition: string): Promise<FargateTaskDefinition>;
	describeCluster(cluster: string): Promise<void>;
}

export interface FargateTaskDefinitionResolver {
	resolve(imageKey: string | undefined): Promise<{
		taskDefinition: string;
		containerName: string;
		imageKey: string;
	}>;
}

export interface FargateConfig {
	cluster: string;
	taskDefinition: string;
	containerName?: string;
	subnets: readonly string[];
	securityGroups: readonly string[];
	assignPublicIp?: boolean;
	platformVersion?: string;
	owner: string;
	agentSecret: string;
	agentPort?: number;
	readyTimeoutMs?: number;
	exposureMode?: SandboxExposureMode;
	imageKey?: string;
}

export interface FargateCreateOptions extends CreateSandboxOptions {
	image?: string;
}

export interface FargateActiveSandbox extends ActiveSandbox {
	taskArn?: string;
}

export interface FargateFailure {
	arn?: string;
	reason?: string;
	detail?: string;
}

export interface FargateTaskHandle {
	taskArn: string;
	taskDefinitionArn?: string;
	containerName: string;
	privateIp: string;
	createdAt?: string;
	imageKey: string;
}

export const FARGATE_SIZE_OPTIONS: readonly {
	cpu: number;
	cpuUnits: string;
	minMemoryGi: number;
	maxMemoryGi: number;
	memoryStepGi: number;
}[] = [
	{ cpu: 0.25, cpuUnits: '256', minMemoryGi: 0.5, maxMemoryGi: 2, memoryStepGi: 0.5 },
	{ cpu: 0.5, cpuUnits: '512', minMemoryGi: 1, maxMemoryGi: 4, memoryStepGi: 1 },
	{ cpu: 1, cpuUnits: '1024', minMemoryGi: 2, maxMemoryGi: 8, memoryStepGi: 1 },
	{ cpu: 2, cpuUnits: '2048', minMemoryGi: 4, maxMemoryGi: 16, memoryStepGi: 1 },
	{ cpu: 4, cpuUnits: '4096', minMemoryGi: 8, maxMemoryGi: 30, memoryStepGi: 1 },
	{ cpu: 8, cpuUnits: '8192', minMemoryGi: 16, maxMemoryGi: 60, memoryStepGi: 4 },
	{ cpu: 16, cpuUnits: '16384', minMemoryGi: 32, maxMemoryGi: 120, memoryStepGi: 8 },
	{ cpu: 32, cpuUnits: '32768', minMemoryGi: 64, maxMemoryGi: 240, memoryStepGi: 8 },
];

export class FargateProfileError extends Error {
	constructor(message: string) {
		super(`Invalid Fargate compute profile: ${message}`);
		this.name = 'FargateProfileError';
	}
}

function ceilToStep(value: number, step: number): number {
	return Math.ceil((value - 1e-12) / step) * step;
}

/** Pick the smallest official Fargate CPU/memory allocation meeting a request. */
export function fargateProfileResources(
	resources: ComputeResources | undefined,
): { cpu: string; memory: string } | undefined {
	if (!resources) return undefined;
	if (resources.gpu !== undefined) {
		throw new FargateProfileError('GPU profiles are not supported by Fargate');
	}
	const requestedCpu = resources.cpu ?? 0;
	const requestedMemoryGi = (resources.memoryBytes ?? 0) / 1024 ** 3;
	if (
		requestedCpu < 0 ||
		requestedMemoryGi < 0 ||
		!Number.isFinite(requestedCpu + requestedMemoryGi)
	) {
		throw new FargateProfileError('CPU and memory must be finite, non-negative values');
	}
	if (requestedCpu === 0 && requestedMemoryGi === 0) return undefined;
	const candidates = FARGATE_SIZE_OPTIONS.flatMap((size) => {
		const memory = Math.max(size.minMemoryGi, ceilToStep(requestedMemoryGi, size.memoryStepGi));
		return memory <= size.maxMemoryGi && size.cpu >= requestedCpu ? [{ size, memory }] : [];
	});
	if (candidates.length === 0) {
		throw new FargateProfileError(
			`requested ${requestedCpu || 'any'} CPU cores and ${requestedMemoryGi || 'any'} GiB exceeds the largest supported allocation (32 vCPU, 240 GiB)`,
		);
	}
	candidates.sort((a, b) => a.size.cpu - b.size.cpu || a.memory - b.memory);
	const selected = candidates[0];
	return { cpu: selected.size.cpuUnits, memory: `${selected.memory}Gi` };
}

export const resolveFargateResources = fargateProfileResources;

export function validateFargateOwner(owner: string): string {
	const normalized = owner.trim();
	if (!normalized) throw new Error('Fargate owner must not be empty');
	if (normalized.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)) {
		throw new Error(
			'Fargate owner must be 1-128 characters of letters, numbers, hyphens, or underscores',
		);
	}
	return normalized;
}

export function deterministicClientToken(owner: string, sandboxId: string): string {
	return `mh-${createHash('sha256').update(`${owner}\0${sandboxId}`).digest('hex').slice(0, 48)}`;
}

export function deriveAgentToken(masterSecret: string, sandboxId: string): string {
	if (Buffer.byteLength(masterSecret, 'utf8') < 32) {
		throw new Error('Fargate agent secret must be at least 32 bytes');
	}
	return createHmac('sha256', masterSecret).update(sandboxId).digest('hex');
}

export function tagMap(
	tags: readonly { key?: string; value?: string }[] | undefined,
): Map<string, string> {
	return new Map(
		(tags ?? [])
			.filter((tag): tag is { key: string; value: string } =>
				Boolean(tag.key && tag.value !== undefined),
			)
			.map((tag) => [tag.key, tag.value]),
	);
}

export function privateIpFromTask(task: FargateTask, containerName: string): string | undefined {
	const container = task.containers?.find((candidate) => candidate.name === containerName);
	const direct = container?.networkInterfaces?.find(
		(network) => network.privateIpv4Address,
	)?.privateIpv4Address;
	if (direct) return direct;
	for (const attachment of task.attachments ?? []) {
		if (attachment.type !== 'eni') continue;
		const value = attachment.details?.find((detail) => detail.name === 'privateIPv4Address')?.value;
		if (value) return value;
	}
	return undefined;
}

export function taskDiagnostic(task: FargateTask | undefined): string {
	if (!task) return 'task was not returned by ECS';
	const container = task.containers?.find(
		(candidate) => candidate.reason || candidate.exitCode !== undefined,
	);
	const parts = [
		task.stopCode,
		task.stoppedReason,
		container?.reason,
		container?.exitCode === undefined ? undefined : `exit code ${container.exitCode}`,
	].filter((value): value is string => Boolean(value));
	return parts.length > 0 ? parts.join('; ') : `task status ${task.lastStatus ?? 'unknown'}`;
}

export function isLiveTask(task: FargateTask): boolean {
	return (
		task.lastStatus === 'RUNNING' ||
		task.lastStatus === 'PENDING' ||
		task.desiredStatus === 'RUNNING'
	);
}
