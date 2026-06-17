/**
 * Map temporary S3 credentials onto the environment variables an S3 SDK (boto3,
 * s3fs, aws-cli) reads, so a notebook can use a federated bucket with no code.
 * Pure — no I/O.
 */
import type { TempS3Creds } from '../../ports/credentialBroker';

/**
 * @param creds    temporary credentials from a `CredentialBroker.exchange`.
 * @param endpoint object-store S3 endpoint (e.g. CAIOS) for a non-AWS store; omit
 *                 for AWS S3. Injected S3-scoped (`AWS_ENDPOINT_URL_S3`).
 * @param region   optional region; some SDKs require one to be set.
 */
export function s3CredsToEnv(
	creds: TempS3Creds,
	endpoint?: string,
	region?: string,
): Record<string, string> {
	const env: Record<string, string> = {
		AWS_ACCESS_KEY_ID: creds.accessKeyId,
		AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
	};
	if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken;
	// S3-scoped endpoint only — NOT the generic AWS_ENDPOINT_URL, which points every
	// AWS service (STS, etc.) at this store and breaks unrelated SDK calls.
	if (endpoint) env.AWS_ENDPOINT_URL_S3 = endpoint;
	if (region) env.AWS_REGION = region;
	return env;
}
