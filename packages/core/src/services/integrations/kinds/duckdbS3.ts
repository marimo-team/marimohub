import type { QueryReadinessCheck } from '../../../ports/integrations';
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

export function readinessCheck(
	id: string,
	label: string,
	ready: boolean,
	field: string,
	reason: string,
): QueryReadinessCheck {
	return { id, label, ready, field, reason };
}

export function s3EndpointReadiness(
	endpoint: URL | undefined,
	field: string,
	label: string,
): QueryReadinessCheck[] {
	return [
		readinessCheck(
			's3-endpoint',
			'Set an explicit S3 endpoint',
			endpoint !== undefined,
			field,
			`S3 endpoint missing. Set ${label} (${field}) to your storage service URL. For AWS S3, replace the region in https://s3.us-east-1.amazonaws.com with your bucket’s region. Do not include the bucket name or object path.`,
		),
		readinessCheck(
			's3-endpoint-origin',
			'Use an origin-only S3 endpoint',
			endpoint?.pathname === '/' && endpoint.search === '' && endpoint.hash === '',
			field,
			`${label} (${field}) must contain only the scheme and host, with an optional port. Remove the bucket name, path, query parameters, and fragment.`,
		),
	];
}
