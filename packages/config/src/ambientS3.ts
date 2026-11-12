import { defaultProvider } from '@aws-sdk/credential-provider-node';
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
): string | undefined {
	if (!enabled) {
		return 'Ambient credentials use the server’s AWS identity. Ask a deployment administrator to set MARIMOHUB_DATA_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS=true and restart the server. Alternatively, set Storage → Credentials to static and provide an access key and secret key.';
	}
	if (blockedBucket && locations.some(({ bucket }) => bucket === blockedBucket)) {
		return 'Control-plane storage is not available through ambient credentials.';
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
					anonymous?: boolean;
					credentials?: { method?: string };
					broker_read_locations?: { bucket: string }[];
				};
			} | null
		)?.storage;
		if (storage?.scheme !== 's3' || storage.anonymous || storage.credentials?.method !== 'ambient')
			return;
		const reason = ambientS3Blocker(
			enabled,
			env.MARIMOHUB_STORAGE_S3_BUCKET,
			storage.broker_read_locations ?? [],
		);
		if (reason)
			return {
				id: 'ambient-s3-access',
				label: 'Allow server ambient S3 credentials',
				field: 'storage.credentials',
				ready: false,
				reason,
			};
	};
}
