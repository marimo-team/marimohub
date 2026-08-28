import type {
	DuckDBPreviewStatement,
	DuckDBS3Credentials,
	DuckDBS3StorageAccess,
} from '../data-preview/programs';
import { sqlIdentifier } from '../data-preview/sql';
import { normalizeBrokerPrefix } from './common';

export function brokeredS3Secret(options: {
	suffix: string;
	endpoint: string;
	region?: string;
	urlStyle: 'path' | 'vhost';
}): { create: DuckDBPreviewStatement; drop: DuckDBPreviewStatement } {
	const endpoint = new URL(options.endpoint);
	const name = sqlIdentifier(`marimohub_s3_${options.suffix}`);
	return {
		create: {
			text:
				`CREATE TEMPORARY SECRET ${name} (` +
				"TYPE S3, KEY_ID 'marimohub-parent-broker', SECRET 'marimohub-parent-broker', " +
				`REGION ?, ENDPOINT ?, URL_STYLE '${options.urlStyle}', USE_SSL ?)`,
			params: [options.region ?? 'us-east-1', endpoint.host, endpoint.protocol === 'https:'],
		},
		drop: { text: `DROP SECRET ${name}` },
	};
}

export function staticS3Credentials(credentials: {
	access_key_id: string;
	secret_access_key: string;
	session_token?: string;
}): DuckDBS3Credentials {
	return {
		method: 'static',
		accessKeyId: credentials.access_key_id,
		secretAccessKey: credentials.secret_access_key,
		...(credentials.session_token ? { sessionToken: credentials.session_token } : {}),
	};
}

export function duckdbS3StorageAccess(options: {
	endpoint: string;
	region?: string;
	urlStyle: 'path' | 'vhost';
	credentials: DuckDBS3Credentials;
	locations: readonly { bucket: string; prefix: string }[];
}): DuckDBS3StorageAccess {
	return {
		endpoint: options.endpoint,
		region: options.region ?? 'us-east-1',
		urlStyle: options.urlStyle,
		credentials: options.credentials,
		locations: options.locations.map(({ bucket, prefix }) => ({
			bucket,
			prefix: normalizeBrokerPrefix(prefix),
		})),
	};
}
