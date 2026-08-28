import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { DuckDBDataQueryPlan } from '../data-query';
import type { DuckDBDuckLakeHttpAccess } from '../data-preview/programs';
import { sqlIdentifier, sqlLiteral } from '../data-preview/sql';
import { defineIntegration } from '../sdk';
import {
	AWS_REGION_REGEX,
	awsStaticCredentials,
	httpUrlField,
	isValidS3Bucket,
	s3BrokerReadLocationsSchema,
} from './common';
import {
	exactObjectAccess,
	exactObjectAuthSchema,
	normalizeExactObjectUrl,
} from './binaryDatabase';

const metadataSchema = z.strictObject({
	type: z.literal('duckdb'),
	url: z.string().min(1).describe('Exact HTTPS URL of one immutable DuckLake metadata file'),
	auth: exactObjectAuthSchema,
	allow_non_database_suffix: z.boolean().default(false),
});

const storageSchema = z.strictObject({
	scheme: z.literal('s3'),
	endpoint: httpUrlField(),
	region: z.string().regex(AWS_REGION_REGEX, 'Region name only, e.g. us-east-1'),
	force_virtual_addressing: z.boolean().default(true),
	credentials: z.strictObject({ method: z.literal('static'), ...awsStaticCredentials }),
	broker_read_locations: s3BrokerReadLocationsSchema.min(
		1,
		'DuckLake requires at least one guarded S3 read location',
	),
});

const snapshotSchema = z
	.strictObject({
		version: z.number().int().nonnegative().optional(),
		timestamp: z.iso.datetime().optional(),
	})
	.refine((snapshot) => snapshot.version === undefined || snapshot.timestamp === undefined, {
		message: 'Set only one of snapshot.version or snapshot.timestamp',
	});

const configSchema = z
	.strictObject({
		metadata: metadataSchema,
		storage: storageSchema,
		snapshot: snapshotSchema.default({}),
	})
	.superRefine((config, context) => {
		try {
			normalizeDuckLakeMetadataUrl(config.metadata);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				path: ['metadata', 'url'],
				message: error instanceof Error ? error.message : 'Invalid DuckLake metadata URL.',
			});
		}
		try {
			validateDuckLakeStorage(config.storage);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				path: ['storage'],
				message: error instanceof Error ? error.message : 'Invalid DuckLake S3 storage.',
			});
		}
		try {
			validateRouteOwnership(config);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				path: ['metadata', 'url'],
				message: error instanceof Error ? error.message : 'DuckLake route ownership is invalid.',
			});
		}
	});

type DuckLakeConfig = z.infer<typeof configSchema>;

export const ducklake = defineIntegration({
	kind: 'ducklake',
	title: 'DuckLake',
	description: 'Query an immutable DuckLake metadata snapshot with guarded S3 data access.',
	category: 'database',
	brand: { color: '#FFF000' },
	schemaVersion: 1,
	configSchema,
	requirements: [],
	uiHints: {
		metadata: { group: 'Metadata', order: 1 },
		'metadata.auth': { group: 'Metadata authentication', order: 10 },
		'metadata.auth.token': { widget: 'password' },
		'metadata.auth.password': { widget: 'password' },
		'metadata.allow_non_database_suffix': { advanced: true, widget: 'toggle' },
		storage: { group: 'S3 storage', order: 20 },
		'storage.credentials.access_key_id': { widget: 'password' },
		'storage.credentials.secret_access_key': { widget: 'password' },
		'storage.credentials.session_token': { widget: 'password' },
		snapshot: { group: 'Snapshot', order: 30 },
	},

	validate(config) {
		normalizeDuckLakeMetadataUrl(config.metadata);
		validateDuckLakeStorage(config.storage);
		validateRouteOwnership(config);
	},

	query: {
		engine: 'duckdb-wasm',
		dialect: 'duckdb',
		readiness: () => [],
		available: () => ({ ok: true }),
		plan({ config, integration }) {
			return duckLakeQueryPlan(config, integration);
		},
	},

	render() {
		return {};
	},
});

function duckLakeQueryPlan(
	config: DuckLakeConfig,
	integration: { id: string; name: string },
): DuckDBDataQueryPlan {
	const alias = sqlIdentifier(integration.name);
	const secretName = sqlIdentifier(`marimohub_s3_${integration.id.replaceAll('-', '_')}`);
	const endpoint = new URL(config.storage.endpoint);
	const urlStyle = config.storage.force_virtual_addressing ? 'vhost' : 'path';
	const metadataUrl = normalizeDuckLakeMetadataUrl(config.metadata);
	const snapshot =
		config.snapshot.version !== undefined
			? { text: ', SNAPSHOT_VERSION ?', value: config.snapshot.version }
			: config.snapshot.timestamp !== undefined
				? { text: ', SNAPSHOT_TIME ?', value: config.snapshot.timestamp }
				: undefined;
	return {
		engine: 'duckdb-wasm',
		setup: [
			{ text: 'LOAD httpfs' },
			{ text: 'LOAD parquet' },
			{ text: 'LOAD ducklake' },
			{
				text:
					`CREATE TEMPORARY SECRET ${secretName} (` +
					"TYPE S3, KEY_ID 'marimohub-parent-broker', SECRET 'marimohub-parent-broker', " +
					`REGION ?, ENDPOINT ?, URL_STYLE '${urlStyle}', USE_SSL ?)`,
				params: [config.storage.region, endpoint.host, endpoint.protocol === 'https:'],
			},
			{
				text:
					`ATTACH ${sqlLiteral(`ducklake:${metadataUrl}`)} AS ${alias} (` +
					`READ_ONLY, CREATE_IF_NOT_EXISTS false${snapshot?.text ?? ''})`,
				...(snapshot ? { params: [snapshot.value] } : {}),
			},
		],
		cleanup: [{ text: `DROP SECRET ${secretName}` }, { text: `DETACH ${alias}` }],
		httpAccess: duckLakeAccess(config),
	};
}

function duckLakeAccess(config: DuckLakeConfig): DuckDBDuckLakeHttpAccess {
	const storage = config.storage;
	validateDuckLakeStorage(config.storage);
	return {
		kind: 'ducklake',
		metadata: exactObjectAccess(
			normalizeDuckLakeMetadataUrl(config.metadata),
			config.metadata.auth,
		),
		storage: {
			endpoint: new URL(storage.endpoint).toString(),
			region: storage.region,
			urlStyle: storage.force_virtual_addressing ? 'vhost' : 'path',
			credentials: {
				method: 'static',
				accessKeyId: storage.credentials.access_key_id,
				secretAccessKey: storage.credentials.secret_access_key,
				...(storage.credentials.session_token
					? { sessionToken: storage.credentials.session_token }
					: {}),
			},
			locations: storage.broker_read_locations.map(({ bucket, prefix }) => ({
				bucket,
				prefix: prefix.replaceAll(/^\/+|\/+$/g, ''),
			})),
		},
	};
}

function validateDuckLakeStorage(storage: DuckLakeConfig['storage']): void {
	const endpoint = new URL(storage.endpoint);
	if (
		endpoint.protocol !== 'https:' ||
		endpoint.pathname !== '/' ||
		endpoint.search !== '' ||
		endpoint.hash !== ''
	) {
		throw new ValidationError('DuckLake requires an origin-only HTTPS S3 endpoint.');
	}
	if (
		storage.force_virtual_addressing &&
		storage.broker_read_locations.some(({ bucket }) => !isValidS3Bucket(bucket))
	) {
		throw new ValidationError(
			'DuckLake virtual-hosted S3 access requires DNS-compatible bucket names.',
		);
	}
	if (storage.force_virtual_addressing && isIpAddressHost(endpoint.hostname)) {
		throw new ValidationError('DuckLake virtual-hosted S3 access requires a DNS endpoint.');
	}
}

function isIpAddressHost(hostname: string): boolean {
	if (hostname.includes(':')) return true;
	const octets = hostname.split('.');
	return (
		octets.length === 4 &&
		octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
	);
}

function validateRouteOwnership(config: DuckLakeConfig): void {
	const metadata = new URL(normalizeDuckLakeMetadataUrl(config.metadata));
	const endpoint = new URL(config.storage.endpoint);
	const metadataSegments = decodePathSegments(metadata.pathname);
	for (const location of config.storage.broker_read_locations) {
		const prefixSegments = location.prefix.replaceAll(/^\/+|\/+$/g, '').split('/');
		const storageSegments = config.storage.force_virtual_addressing
			? prefixSegments
			: [location.bucket, ...prefixSegments];
		const expectedHost = config.storage.force_virtual_addressing
			? `${location.bucket}.${endpoint.hostname}${endpoint.port ? `:${endpoint.port}` : ''}`
			: endpoint.host;
		if (
			metadata.protocol === endpoint.protocol &&
			metadata.host === expectedHost &&
			storageSegments.every((segment, index) => metadataSegments[index] === segment)
		) {
			throw new ValidationError(
				'DuckLake metadata URL must not overlap a guarded S3 data location.',
			);
		}
	}
}

function decodePathSegments(pathname: string): string[] {
	return pathname
		.split('/')
		.filter(Boolean)
		.map((segment) => decodeURIComponent(segment));
}

export function normalizeDuckLakeMetadataUrl(
	metadata: Pick<DuckLakeConfig['metadata'], 'type' | 'url' | 'allow_non_database_suffix'>,
): string {
	return normalizeExactObjectUrl({
		url: metadata.url,
		allowedSuffixes: ['.ducklake', '.duckdb'],
		allowOtherSuffix: metadata.allow_non_database_suffix,
		label: 'DuckLake metadata',
	});
}
