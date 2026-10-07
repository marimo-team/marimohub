import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { z } from 'zod';
import { UnavailableError } from '@marimo-hub/core/errors';
import type { PackageRegistryCredentialProvider } from '@marimo-hub/core/ports/package-registry';

const responseSchema = z.object({
	authorizationToken: z
		.string()
		.min(1)
		.max(16384)
		.regex(/^[\x21-\x7e]+$/),
	expiration: z.number(),
});

export class AwsCodeArtifactCredentials implements PackageRegistryCredentialProvider {
	async resolve(
		source: Parameters<PackageRegistryCredentialProvider['resolve']>[0],
		options: Parameters<PackageRegistryCredentialProvider['resolve']>[1],
	) {
		if (source.auth.method === 'token') {
			return { username: 'aws', password: source.auth.token };
		}
		try {
			options.signal?.throwIfAborted();
			// Never fall back to the hub's ambient AWS identity for project-authored configuration.
			const credentials =
				source.auth.method === 'static'
					? {
							accessKeyId: source.auth.access_key_id,
							secretAccessKey: source.auth.secret_access_key,
							sessionToken: source.auth.session_token,
						}
					: options.awsCredentials;
			if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
				throw new Error('Missing AWS credentials');
			}
			if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(source.region)) throw new Error('Invalid region');
			const suffix = source.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
			const hostname = `codeartifact.${source.region}.${suffix}`;
			const query = {
				domain: source.domain,
				'domain-owner': source.domain_owner,
				duration: String(source.duration_seconds),
			};
			const deadline = AbortSignal.timeout(10_000);
			const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
			const { accessKeyId, secretAccessKey, sessionToken } = credentials;
			const signer = new SignatureV4({
				credentials: { accessKeyId, secretAccessKey, sessionToken },
				region: source.region,
				service: 'codeartifact',
				sha256: Sha256,
			});
			const signed = await signer.sign({
				method: 'POST',
				protocol: 'https:',
				hostname,
				path: '/v1/authorization-token',
				query,
				headers: { host: hostname, accept: 'application/json' },
			});
			signal.throwIfAborted();
			const response = await options.probe.fetch(
				`https://${hostname}/v1/authorization-token?${new URLSearchParams(query)}`,
				{ method: 'POST', headers: signed.headers, signal },
			);
			if (!response.ok) throw new Error('CodeArtifact rejected the request');
			const parsed = responseSchema.parse(await response.json());
			if (parsed.expiration * 1000 <= Date.now()) throw new Error('Expired CodeArtifact token');
			return {
				username: 'aws',
				password: parsed.authorizationToken,
				expiresAt: new Date(parsed.expiration * 1000).toISOString(),
			};
		} catch {
			throw new UnavailableError(
				'CodeArtifact authentication failed. Check the AWS credentials, region, domain, and IAM permissions.',
			);
		}
	}
}
