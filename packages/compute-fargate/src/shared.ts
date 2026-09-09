import { createHash, createHmac } from 'node:crypto';
import type {
	ActiveSandbox,
	ComputeResources,
	CreateSandboxOptions,
	SandboxExposureMode,
} from '@marimo-hub/core/ports';

export const FARGATE_PROTOCOL_VERSION = 2;
export const DEFAULT_AGENT_PORT = 2717;
export const DEFAULT_KERNEL_PORT = 2718;
export const DEFAULT_READY_TIMEOUT_MS = 120_000;
export const AGENT_HEALTH_TIMEOUT_MS = 2_000;
export const AGENT_TRANSPORT_GRACE_MS = 1_000;
export const DEFAULT_CONTAINER_NAME = 'marimo';
export const DEFAULT_IMAGE_KEY = 'default';
export const MAX_AGENT_BODY_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WRITE_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_EXEC_OUTPUT_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4;

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
	taskRoleArn?: string;
	networkMode?: string;
	requiresCompatibilities?: readonly string[];
	containerNames?: readonly string[];
	staticCredentialContainers?: readonly string[];
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

type MemoryValues = readonly number[];

function rangeGi(start: number, end: number, step: number): MemoryValues {
	const values: number[] = [];
	for (let value = start; value <= end + Number.EPSILON; value += step) {
		values.push(Number(value.toFixed(6)));
	}
	return values;
}

export const FARGATE_SIZE_OPTIONS: readonly {
	cpu: number;
	cpuUnits: string;
	memoryGi: MemoryValues;
}[] = [
	{ cpu: 0.25, cpuUnits: '256', memoryGi: [0.5, 1, 2] },
	{ cpu: 0.5, cpuUnits: '512', memoryGi: [1, 2, 3, 4] },
	{ cpu: 1, cpuUnits: '1024', memoryGi: rangeGi(2, 8, 1) },
	{ cpu: 2, cpuUnits: '2048', memoryGi: rangeGi(4, 16, 1) },
	{ cpu: 4, cpuUnits: '4096', memoryGi: rangeGi(8, 30, 1) },
	{ cpu: 8, cpuUnits: '8192', memoryGi: rangeGi(16, 60, 4) },
	{ cpu: 16, cpuUnits: '16384', memoryGi: rangeGi(32, 120, 8) },
	{ cpu: 32, cpuUnits: '32768', memoryGi: [60, 120, 244] },
];

export class FargateProfileError extends Error {
	constructor(message: string) {
		super(`Invalid Fargate compute profile: ${message}`);
		this.name = 'FargateProfileError';
	}
}

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
		const memory = size.memoryGi.find((value) => value >= requestedMemoryGi);
		return memory !== undefined && size.cpu >= requestedCpu ? [{ size, memory }] : [];
	});
	if (candidates.length === 0) {
		throw new FargateProfileError(
			`requested ${requestedCpu || 'any'} CPU cores and ${requestedMemoryGi || 'any'} GiB exceeds the largest supported allocation (32 vCPU, 244 GiB)`,
		);
	}
	candidates.sort((a, b) => a.size.cpu - b.size.cpu || a.memory - b.memory);
	const selected = candidates[0];
	return { cpu: selected.size.cpuUnits, memory: String(Math.round(selected.memory * 1024)) };
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

export function validateFargateTaskDefinition(taskDefinition: string): string {
	const value = taskDefinition.trim();
	const familyRevision = /^[A-Za-z0-9][A-Za-z0-9_-]*:[1-9]\d*$/.test(value);
	const arnRevision = /^arn:[^:]+:ecs:[^:]*:[^:]*:task-definition\/[^:]+:[1-9]\d*$/.test(value);
	if (!familyRevision && !arnRevision) {
		throw new Error(
			'Fargate task definition must include a numeric revision (family:revision or ECS task-definition ARN)',
		);
	}
	return value;
}

export function deterministicClientToken(
	owner: string,
	sandboxId: string,
	generation: string,
): string {
	return `mh-${createHash('sha256')
		.update(`${owner}\0${sandboxId}\0${generation}`)
		.digest('hex')
		.slice(0, 48)}`;
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
	const result = new Map<string, string>();
	for (const tag of tags ?? []) {
		if (!tag.key || tag.value === undefined) continue;
		if (result.has(tag.key)) throw new Error(`duplicate ECS tag ${tag.key}`);
		result.set(tag.key, tag.value);
	}
	return result;
}

export function tagValues(
	tags: readonly { key?: string; value?: string }[] | undefined,
	key: string,
): string[] {
	return (tags ?? [])
		.filter(
			(tag): tag is { key: string; value: string } => tag.key === key && tag.value !== undefined,
		)
		.map((tag) => tag.value);
}

export function privateIpFromTask(task: FargateTask, containerName: string): string | undefined {
	const container = task.containers?.find((candidate) => candidate.name === containerName);
	const direct = container?.networkInterfaces?.find(
		(network) => network.privateIpv4Address,
	)?.privateIpv4Address;
	if (direct) return direct;
	for (const attachment of task.attachments ?? []) {
		if (attachment.type !== 'eni' && attachment.type !== 'ElasticNetworkInterface') continue;
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
