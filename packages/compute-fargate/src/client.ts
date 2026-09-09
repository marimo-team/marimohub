import {
	DescribeClustersCommand,
	DescribeTaskDefinitionCommand,
	DescribeTasksCommand,
	ECSClient,
	ListTasksCommand,
	RunTaskCommand,
	StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { Container, Failure, Task, Tag, TaskDefinition } from '@aws-sdk/client-ecs';
import type {
	FargateClient,
	FargateContainer,
	FargateFailure,
	FargateRunTaskInput,
	FargateTask,
	FargateTaskDefinition,
} from './shared';

function mapContainer(container: Container): FargateContainer {
	return {
		name: container.name,
		lastStatus: container.lastStatus,
		exitCode: container.exitCode,
		reason: container.reason,
		networkInterfaces: container.networkInterfaces?.map((network) => ({
			privateIpv4Address: network.privateIpv4Address,
		})),
	};
}

function mapTask(task: Task): FargateTask {
	return {
		taskArn: task.taskArn,
		taskDefinitionArn: task.taskDefinitionArn,
		lastStatus: task.lastStatus,
		desiredStatus: task.desiredStatus,
		createdAt: task.createdAt?.toISOString(),
		startedAt: task.startedAt?.toISOString(),
		stoppedAt: task.stoppedAt?.toISOString(),
		stoppedReason: task.stoppedReason,
		stopCode: task.stopCode,
		containers: task.containers?.map(mapContainer),
		attachments: task.attachments?.map((attachment) => ({
			type: attachment.type,
			details: attachment.details?.map((detail) => ({ name: detail.name, value: detail.value })),
		})),
		tags: task.tags?.map((tag) => ({ key: tag.key, value: tag.value })),
	};
}

function mapFailure(failure: Failure): FargateFailure {
	return { arn: failure.arn, reason: failure.reason, detail: failure.detail };
}

function mapTags(tags: readonly { key: string; value: string }[]): Tag[] {
	return tags.map(({ key, value }) => ({ key, value }));
}

function mapTaskDefinition(definition: TaskDefinition): FargateTaskDefinition {
	const staticCredentialNames = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
	return {
		taskDefinitionArn: definition.taskDefinitionArn,
		family: definition.family,
		revision: definition.revision,
		taskRoleArn: definition.taskRoleArn,
		networkMode: definition.networkMode,
		requiresCompatibilities: definition.requiresCompatibilities,
		containerNames: definition.containerDefinitions?.flatMap((container) =>
			container.name ? [container.name] : [],
		),
		staticCredentialContainers: definition.containerDefinitions?.flatMap((container) => {
			if (!container.name) return [];
			const names = [
				...(container.environment ?? []).map((entry) => entry.name),
				...(container.secrets ?? []).map((entry) => entry.name),
			];
			return names.some((name) => staticCredentialNames.has(name ?? '')) ? [container.name] : [];
		}),
	};
}

export interface AwsFargateClientOptions {
	region?: string;
	client?: ECSClient;
}

export function createFargateClient(options: AwsFargateClientOptions = {}): FargateClient {
	const ecs = options.client ?? new ECSClient({ region: options.region });
	return {
		async runTask(input: FargateRunTaskInput) {
			const result = await ecs.send(
				new RunTaskCommand({
					cluster: input.cluster,
					taskDefinition: input.taskDefinition,
					startedBy: input.startedBy,
					clientToken: input.clientToken,
					platformVersion: input.platformVersion,
					count: input.count,
					launchType: 'FARGATE',
					networkConfiguration: {
						awsvpcConfiguration: {
							subnets: [...input.networkConfiguration.subnets],
							securityGroups: [...input.networkConfiguration.securityGroups],
							assignPublicIp: input.networkConfiguration.assignPublicIp ? 'ENABLED' : 'DISABLED',
						},
					},
					tags: mapTags(input.tags),
					overrides: input.overrides
						? {
								cpu: input.overrides.cpu,
								memory: input.overrides.memory,
								containerOverrides: input.overrides.containerOverrides?.map((override) => ({
									name: override.name,
									environment: override.environment.map(({ name, value }) => ({ name, value })),
								})),
							}
						: undefined,
				}),
			);
			return {
				tasks: result.tasks?.map(mapTask),
				failures: result.failures?.map(mapFailure),
			};
		},

		async describeTasks(cluster, taskArns, includeTags = false) {
			if (taskArns.length === 0) return {};
			const result = await ecs.send(
				new DescribeTasksCommand({
					cluster,
					tasks: [...taskArns],
					include: includeTags ? ['TAGS'] : undefined,
				}),
			);
			return {
				tasks: result.tasks?.map(mapTask),
				failures: result.failures?.map(mapFailure),
			};
		},

		async listTasks(cluster, startedBy, nextToken) {
			const result = await ecs.send(new ListTasksCommand({ cluster, startedBy, nextToken }));
			return { taskArns: result.taskArns, nextToken: result.nextToken };
		},

		async stopTask(cluster, task, reason) {
			await ecs.send(new StopTaskCommand({ cluster, task, reason }));
		},

		async describeTaskDefinition(taskDefinition) {
			const result = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition }));
			return result.taskDefinition ? mapTaskDefinition(result.taskDefinition) : {};
		},

		async describeCluster(cluster) {
			const result = await ecs.send(new DescribeClustersCommand({ clusters: [cluster] }));
			if (
				!result.clusters?.some(
					(candidate) => candidate.clusterName === cluster || candidate.clusterArn === cluster,
				)
			) {
				const failure = result.failures?.[0];
				throw new Error(
					`ECS cluster ${cluster} was not found${failure?.reason ? `: ${failure.reason}` : ''}`,
				);
			}
		},
	};
}
