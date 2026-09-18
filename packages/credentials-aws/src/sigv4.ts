import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, Provider, QueryParameterBag } from '@smithy/types';

export interface AwsSigV4FetchOptions {
	region: string;
	service: string;
	credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
	fetch?: typeof globalThis.fetch;
}

function queryParameters(url: URL): QueryParameterBag {
	const query: QueryParameterBag = {};
	for (const [key, value] of url.searchParams) {
		const current = query[key];
		if (current === undefined || current === null) query[key] = value;
		else if (Array.isArray(current)) current.push(value);
		else query[key] = [current, value];
	}
	return query;
}

/**
 * The keyless AWS credential chain (IRSA web-identity, ECS/EC2 metadata, env,
 * shared config). Returns a provider the AWS SDK re-invokes to refresh; SDK
 * clients that accept a credential provider (e.g. the Bedrock AI provider) reuse
 * the same identity the SigV4 fetch signs with — no static keys anywhere.
 */
export function awsDefaultCredentialProvider(): Provider<AwsCredentialIdentity> {
	return defaultProvider();
}

export function createAwsSigV4Fetch(options: AwsSigV4FetchOptions): typeof globalThis.fetch {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const signer = new SignatureV4({
		credentials: options.credentials ?? defaultProvider(),
		region: options.region,
		service: options.service,
		sha256: Sha256,
	});

	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const body =
			request.method === 'GET' || request.method === 'HEAD'
				? undefined
				: await request.clone().arrayBuffer();
		const headers = Object.fromEntries(request.headers);
		headers.host = url.host;
		const signed = await signer.sign({
			method: request.method,
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port ? Number(url.port) : undefined,
			path: url.pathname,
			query: queryParameters(url),
			headers,
			body,
		});

		return fetchImpl(request.url, {
			method: request.method,
			headers: signed.headers,
			body,
			signal: request.signal,
			redirect: 'error',
		});
	};
}
