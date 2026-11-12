import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { isValidS3Bucket } from '@marimo-hub/core';
import type { IntegrationQueryGate } from '@marimo-hub/core';
import { parseBool } from './env';
import type { Env } from './env';

export interface AmbientS3Access {
	credentials: () => Promise<{
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken?: string;
		expiration?: Date;
	}>;
	blockedBucket?: string;
}

export function ambientS3Blocker(
	enabled: boolean,
	blockedBucket: string | undefined,
	locations: readonly { bucket: string }[],
	endpoint: string | undefined,
): { field: string; reason: string } | undefined {
	if (!enabled) {
		return {
			field: 'storage.credentials',
			reason:
				'Ambient credentials use the server’s AWS identity. Ask a deployment administrator to set MARIMOHUB_DATA_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS=true and restart the server. Alternatively, set Storage → Credentials to static and provide an access key and secret key.',
		};
	}
	if (!isAmbientS3ServiceEndpoint(endpoint)) {
		return {
			field: 'storage.endpoint',
			reason:
				'Ambient SQL requires an HTTPS AWS S3 service endpoint, such as https://s3.us-east-1.amazonaws.com. Remove any bucket name from the endpoint. For custom storage endpoints, use static credentials.',
		};
	}
	if (
		locations.some(
			({ bucket }) =>
				!isValidS3Bucket(bucket) || /(?:-s3alias|--ol-s3|--x-s3|--table-s3|\.mrap)$/.test(bucket),
		)
	) {
		return {
			field: 'storage.broker_read_locations',
			reason:
				'Ambient SQL requires ordinary S3 bucket names in read locations. Access-point aliases and directory buckets are not supported.',
		};
	}
	if (blockedBucket && locations.some(({ bucket }) => bucket === blockedBucket)) {
		return {
			field: 'storage.broker_read_locations',
			reason: 'Control-plane storage is not available through ambient credentials.',
		};
	}
}

// On bucket-qualified hosts, path-style bucket names become object-key prefixes.
function isAmbientS3ServiceEndpoint(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			!url.port &&
			url.pathname === '/' &&
			!url.search &&
			!url.hash &&
			(url.hostname === 's3.amazonaws.com' ||
				/^s3(?:-fips)?\.(?:dualstack\.)?[a-z]{2}(?:-[a-z]+)+-\d+\.amazonaws\.com(?:\.cn)?$/.test(
					url.hostname,
				))
		);
	} catch {
		return false;
	}
}

export function ambientS3FromEnv(env: Env): AmbientS3Access | undefined {
	if (!parseBool(env, 'MARIMOHUB_DATA_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS')) return;
	return {
		credentials: defaultProvider(),
		blockedBucket: env.MARIMOHUB_STORAGE_S3_BUCKET,
	};
}

export function ambientS3QueryGate(env: Env): IntegrationQueryGate {
	const enabled = parseBool(env, 'MARIMOHUB_DATA_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS');
	return ({ kind, config }) => {
		if (kind !== 'iceberg_rest') return;
		const storage = (
			config as {
				storage?: {
					scheme?: string;
					endpoint?: string;
					anonymous?: boolean;
					credentials?: { method?: string };
					broker_read_locations?: { bucket: string }[];
				};
			} | null
		)?.storage;
		if (storage?.scheme !== 's3' || storage.anonymous || storage.credentials?.method !== 'ambient')
			return;
		const blocker = ambientS3Blocker(
			enabled,
			env.MARIMOHUB_STORAGE_S3_BUCKET,
			storage.broker_read_locations ?? [],
			storage.endpoint,
		);
		if (blocker)
			return {
				id: 'ambient-s3-access',
				label: 'Allow server ambient S3 credentials',
				ready: false,
				...blocker,
			};
	};
}
