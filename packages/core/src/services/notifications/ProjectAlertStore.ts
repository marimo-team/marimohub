import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { ManagedSecretCodec, SecretEnvelope } from '../../ports/secrets';
import {
	ConflictError,
	NotFoundError,
	ResourceExhaustedError,
	ValidationError,
	assertVersionMatch,
} from '../../errors';
import { createAlertDestinationId } from '../../ids';
import type { AlertDestinationId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import {
	AlertDestinationIdSchema,
	ProjectIdSchema,
	readStored,
	SecretEnvelopeSchema,
	UserIdSchema,
} from '../../schema';
import { withCasRetry } from '../catalog/cas';
import { PROJECT_ALERT_KINDS } from '../../notifications';
import type { ProjectAlertKind } from '../../notifications';
import { nextIsoTimestamp } from '../../utcDate';
import { parseHttpUrl } from '../../url';

export const MAX_PROJECT_ALERT_DESTINATIONS = 10;

export const StoredProjectAlertKindSchema = z.string().min(1);

const StoredDestinationCommonSchema = z.object({
	id: AlertDestinationIdSchema,
	name: z.string().min(1).max(100),
	kinds: z.array(StoredProjectAlertKindSchema).min(1),
	enabled: z.boolean(),
	verified_at: z.iso.datetime().nullable(),
	endpoint_host: z.string().min(1),
	created_by: UserIdSchema,
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
});

const StoredSlackDestinationSchema = StoredDestinationCommonSchema.extend({
	type: z.literal('slack'),
	webhook_url: SecretEnvelopeSchema,
});

const StoredWebhookDestinationSchema = StoredDestinationCommonSchema.extend({
	type: z.literal('webhook'),
	url: SecretEnvelopeSchema,
	signing_secret: SecretEnvelopeSchema,
});

export const StoredProjectAlertDestinationSchema = z.discriminatedUnion('type', [
	StoredSlackDestinationSchema,
	StoredWebhookDestinationSchema,
]);
export type StoredProjectAlertDestination = z.infer<typeof StoredProjectAlertDestinationSchema>;

export const ProjectAlertConfigSchema = z.object({
	schema_version: z.literal(1),
	project_id: ProjectIdSchema,
	destinations: z.array(StoredProjectAlertDestinationSchema).max(MAX_PROJECT_ALERT_DESTINATIONS),
	updated_at: z.iso.datetime(),
});
export type ProjectAlertConfig = z.infer<typeof ProjectAlertConfigSchema>;

export type ProjectAlertDestination =
	| (Omit<z.infer<typeof StoredSlackDestinationSchema>, 'webhook_url' | 'kinds'> & {
			kinds: (ProjectAlertKind | 'unknown')[];
			webhook_url_set: true;
	  })
	| (Omit<z.infer<typeof StoredWebhookDestinationSchema>, 'url' | 'signing_secret' | 'kinds'> & {
			kinds: (ProjectAlertKind | 'unknown')[];
			url_set: true;
			signing_secret_set: true;
	  });

export type ResolvedProjectAlertDestination =
	| (Omit<z.infer<typeof StoredSlackDestinationSchema>, 'webhook_url'> & { webhook_url: string })
	| (Omit<z.infer<typeof StoredWebhookDestinationSchema>, 'url' | 'signing_secret'> & {
			url: string;
			signing_secret: string;
	  });

export type CreateProjectAlertDestinationInput =
	| { name: string; type: 'slack'; kinds?: ProjectAlertKind[]; webhook_url: string }
	| {
			name: string;
			type: 'webhook';
			kinds?: ProjectAlertKind[];
			url: string;
			signing_secret: string;
	  };

export interface UpdateProjectAlertDestinationInput {
	type?: 'slack' | 'webhook';
	name?: string;
	kinds?: ProjectAlertKind[];
	enabled?: boolean;
	webhook_url?: string;
	url?: string;
	signing_secret?: string;
}

function endpoint(value: string): URL {
	const parsed = parseHttpUrl(value, { protocols: ['https:'] });
	if (!parsed.ok && parsed.issue === 'protocol') {
		throw new ValidationError('Alert destination URL must use HTTPS');
	}
	if (!parsed.ok && parsed.issue === 'credentials') {
		throw new ValidationError('Alert destination URL cannot contain embedded credentials');
	}
	if (!parsed.ok) throw new ValidationError('Alert destination URL is invalid');
	return parsed.url;
}

function uniqueKinds(kinds: readonly ProjectAlertKind[] | undefined): ProjectAlertKind[] {
	const values = kinds ?? PROJECT_ALERT_KINDS;
	if (values.length === 0) throw new ValidationError('Select at least one alert kind');
	return [...new Set(values)];
}

export class ProjectAlertStore {
	constructor(
		private readonly bucket: Bucket,
		private readonly codec: ManagedSecretCodec,
	) {}

	async list(projectId: ProjectId): Promise<ProjectAlertDestination[]> {
		const config = await this.load(projectId);
		return config?.destinations.map((destination) => this.redact(destination)) ?? [];
	}

	async create(
		projectId: ProjectId,
		input: CreateProjectAlertDestinationInput,
		actor: UserId,
	): Promise<ProjectAlertDestination> {
		const id = createAlertDestinationId();
		const now = new Date().toISOString();
		const name = input.name.trim();
		if (!name) throw new ValidationError('Alert destination name is required');
		const kinds = uniqueKinds(input.kinds);
		const base = {
			id,
			name,
			kinds,
			enabled: false,
			verified_at: null,
			created_by: actor,
			created_at: now,
			updated_at: now,
		};
		let destination: StoredProjectAlertDestination;
		if (input.type === 'slack') {
			const url = endpoint(input.webhook_url);
			destination = {
				...base,
				type: 'slack',
				endpoint_host: url.hostname,
				webhook_url: await this.encryptSecret(projectId, id, 'webhook_url', input.webhook_url),
			};
		} else {
			const url = endpoint(input.url);
			if (!input.signing_secret) throw new ValidationError('Webhook signing secret is required');
			destination = {
				...base,
				type: 'webhook',
				endpoint_host: url.hostname,
				url: await this.encryptSecret(projectId, id, 'url', input.url),
				signing_secret: await this.encryptSecret(
					projectId,
					id,
					'signing_secret',
					input.signing_secret,
				),
			};
		}

		await this.mutate(projectId, (config) => {
			if (config.destinations.length >= MAX_PROJECT_ALERT_DESTINATIONS) {
				throw new ResourceExhaustedError(
					`Project alert destination limit reached (${MAX_PROJECT_ALERT_DESTINATIONS})`,
				);
			}
			return { ...config, destinations: [...config.destinations, destination], updated_at: now };
		});
		return this.redact(destination);
	}

	async update(
		projectId: ProjectId,
		id: AlertDestinationId,
		input: UpdateProjectAlertDestinationInput,
		expectedVersion?: string,
	): Promise<ProjectAlertDestination> {
		let result: StoredProjectAlertDestination | undefined;
		await this.mutate(projectId, async (config) => {
			const current = config.destinations.find((candidate) => candidate.id === id);
			if (!current) throw new NotFoundError(`Alert destination ${id} not found`);
			assertVersionMatch(current.updated_at, expectedVersion);
			if (input.type !== undefined && input.type !== current.type) {
				throw new ValidationError('Alert destination type cannot be changed');
			}
			const secretChanged =
				(current.type === 'slack' && input.webhook_url !== undefined) ||
				(current.type === 'webhook' &&
					(input.url !== undefined || input.signing_secret !== undefined));
			if (secretChanged && input.enabled === true) {
				throw new ConflictError(
					'Test the replacement endpoint successfully before enabling this destination',
				);
			}
			if (
				current.type === 'slack' &&
				(input.url !== undefined || input.signing_secret !== undefined)
			) {
				throw new ValidationError('Webhook fields cannot update a Slack destination');
			}
			if (current.type === 'webhook' && input.webhook_url !== undefined) {
				throw new ValidationError('Slack fields cannot update a webhook destination');
			}
			if (input.signing_secret?.length === 0) {
				throw new ValidationError('Webhook signing secret is required');
			}
			const updatedAt = nextIsoTimestamp(current.updated_at, new Date().toISOString());
			const name = input.name === undefined ? current.name : input.name.trim();
			const kinds = input.kinds === undefined ? current.kinds : uniqueKinds(input.kinds);
			const verifiedAt = secretChanged ? null : current.verified_at;
			const enabled = secretChanged ? false : (input.enabled ?? current.enabled);
			if (!name) throw new ValidationError('Alert destination name is required');
			if (!secretChanged && input.enabled === true && verifiedAt === null) {
				throw new ConflictError('Test this destination successfully before enabling it');
			}
			const common = {
				name,
				kinds,
				enabled,
				verified_at: verifiedAt,
				updated_at: updatedAt,
			};
			if (current.type === 'slack') {
				const replacement = input.webhook_url;
				const parsed = replacement === undefined ? undefined : endpoint(replacement);
				result = {
					...current,
					...common,
					endpoint_host: parsed?.hostname ?? current.endpoint_host,
					webhook_url:
						replacement === undefined
							? current.webhook_url
							: await this.encryptSecret(projectId, id, 'webhook_url', replacement),
				};
			} else {
				const replacement = input.url;
				const parsed = replacement === undefined ? undefined : endpoint(replacement);
				result = {
					...current,
					...common,
					endpoint_host: parsed?.hostname ?? current.endpoint_host,
					url:
						replacement === undefined
							? current.url
							: await this.encryptSecret(projectId, id, 'url', replacement),
					signing_secret:
						input.signing_secret === undefined
							? current.signing_secret
							: await this.encryptSecret(projectId, id, 'signing_secret', input.signing_secret),
				};
			}
			return {
				...config,
				destinations: config.destinations.map((candidate) =>
					candidate.id === id ? result! : candidate,
				),
				updated_at: updatedAt,
			};
		});
		return this.redact(result!);
	}

	async remove(
		projectId: ProjectId,
		id: AlertDestinationId,
		expectedVersion?: string,
	): Promise<void> {
		await this.mutate(projectId, (config) => {
			const current = config.destinations.find((candidate) => candidate.id === id);
			if (!current) {
				throw new NotFoundError(`Alert destination ${id} not found`);
			}
			assertVersionMatch(current.updated_at, expectedVersion);
			return {
				...config,
				destinations: config.destinations.filter((candidate) => candidate.id !== id),
				updated_at: nextIsoTimestamp(config.updated_at, new Date().toISOString()),
			};
		});
	}

	async resolve(
		projectId: ProjectId,
		options: { id?: AlertDestinationId; kind?: ProjectAlertKind; requireEnabled?: boolean } = {},
	): Promise<ResolvedProjectAlertDestination[]> {
		const config = await this.load(projectId);
		if (!config) return [];
		const selected = config.destinations.filter(
			(destination) =>
				(options.id === undefined || destination.id === options.id) &&
				(options.kind === undefined || destination.kinds.includes(options.kind)) &&
				(!options.requireEnabled || (destination.enabled && destination.verified_at !== null)),
		);
		return Promise.all(selected.map((destination) => this.decrypt(projectId, destination)));
	}

	async markVerified(
		projectId: ProjectId,
		id: AlertDestinationId,
		expectedVersion: string,
	): Promise<ProjectAlertDestination> {
		let result: StoredProjectAlertDestination | undefined;
		await this.mutate(projectId, (config) => {
			const current = config.destinations.find((candidate) => candidate.id === id);
			if (!current) throw new NotFoundError(`Alert destination ${id} not found`);
			if (current.updated_at !== expectedVersion) {
				throw new ConflictError('Alert destination changed during the test; test it again');
			}
			const now = nextIsoTimestamp(current.updated_at, new Date().toISOString());
			result = { ...current, verified_at: now, updated_at: now };
			return {
				...config,
				destinations: config.destinations.map((candidate) =>
					candidate.id === id ? result! : candidate,
				),
				updated_at: now,
			};
		});
		return this.redact(result!);
	}

	private async load(projectId: ProjectId): Promise<ProjectAlertConfig | null> {
		const key = paths.project(projectId).alerts;
		const obj = await this.bucket.get(key);
		if (!obj) return null;
		return readStored(ProjectAlertConfigSchema, obj, key);
	}

	private async mutate(
		projectId: ProjectId,
		apply: (config: ProjectAlertConfig) => ProjectAlertConfig | Promise<ProjectAlertConfig>,
	): Promise<ProjectAlertConfig> {
		const key = paths.project(projectId).alerts;
		return withCasRetry(this.bucket, async (cas) => {
			const obj = await this.bucket.get(key);
			const current = obj
				? await readStored(ProjectAlertConfigSchema, obj, key)
				: {
						schema_version: 1 as const,
						project_id: projectId,
						destinations: [],
						updated_at: new Date(0).toISOString(),
					};
			const next = ProjectAlertConfigSchema.parse(await apply(current));
			await cas.put(
				key,
				JSON.stringify(next),
				obj ? { onlyIfEtagMatches: obj.etag } : { onlyIfNotExists: true },
			);
			return next;
		});
	}

	private redact(destination: StoredProjectAlertDestination): ProjectAlertDestination {
		const kinds = destination.kinds.map((kind) =>
			PROJECT_ALERT_KINDS.includes(kind as ProjectAlertKind)
				? (kind as ProjectAlertKind)
				: 'unknown',
		);
		if (destination.type === 'slack') {
			const { webhook_url: _secret, ...rest } = destination;
			return { ...rest, kinds, webhook_url_set: true };
		}
		const { url: _url, signing_secret: _secret, ...rest } = destination;
		return { ...rest, kinds, url_set: true, signing_secret_set: true };
	}

	private async decrypt(
		projectId: ProjectId,
		destination: StoredProjectAlertDestination,
	): Promise<ResolvedProjectAlertDestination> {
		if (destination.type === 'slack') {
			return {
				...destination,
				webhook_url: await this.decryptSecret(
					projectId,
					destination.id,
					'webhook_url',
					destination.webhook_url,
				),
			};
		}
		return {
			...destination,
			url: await this.decryptSecret(projectId, destination.id, 'url', destination.url),
			signing_secret: await this.decryptSecret(
				projectId,
				destination.id,
				'signing_secret',
				destination.signing_secret,
			),
		};
	}

	private decryptSecret(
		projectId: ProjectId,
		id: AlertDestinationId,
		field: string,
		envelope: SecretEnvelope,
	): Promise<string> {
		return this.codec.decrypt(envelope, { path: this.secretPath(projectId, id, field) });
	}

	private encryptSecret(
		projectId: ProjectId,
		id: AlertDestinationId,
		field: string,
		plaintext: string,
	): Promise<SecretEnvelope> {
		return this.codec.encrypt(plaintext, { path: this.secretPath(projectId, id, field) });
	}

	private secretPath(projectId: ProjectId, id: AlertDestinationId, field: string): string {
		return `${paths.project(projectId).alerts}#destinations/${id}/${field}`;
	}
}
