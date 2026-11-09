import { BoundedLruMap } from '@marimo-hub/core/cache';
import { logEvent } from '@marimo-hub/core/logs';
import { sha256Hex } from '@marimo-hub/core/sha256';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { z } from 'zod';
import { UnavailableError } from '@marimo-hub/core/errors';
import { AWS_REGION_NAME_REGEX, awsDnsSuffix } from '@marimo-hub/core/ports/package-registry';
import type {
	CodeArtifactSource,
	PackageRegistryCredentialProvider,
} from '@marimo-hub/core/ports/package-registry';
import type { TempS3Creds } from '@marimo-hub/core/ports/credential-broker';

/** The AWS maximum; the hub never renews a token, so sessions restart after it expires. */
const TOKEN_DURATION_SECONDS = 43_200;
const MIN_REMAINING_MS = 10 * 60 * 60_000;

type ResolveOptions = Parameters<PackageRegistryCredentialProvider['resolve']>[1];

type Token = { username: string; password: string; expiresAt: string };
interface TokenEntry {
	token: Promise<Token>;
	expiresAt: number;
}

const responseSchema = z.object({
	authorizationToken: z
		.string()
		.min(1)
		.max(16384)
		.regex(/^[\x21-\x7e]+$/),
	expiration: z.number(),
});

export class AwsCodeArtifactCredentials implements PackageRegistryCredentialProvider {
	private readonly tokens: BoundedLruMap<string, TokenEntry>;

	constructor(maxEntries = 4096) {
		this.tokens = new BoundedLruMap(maxEntries);
	}

	async resolve(source: CodeArtifactSource, options: ResolveOptions): Promise<Token> {
		// Never fall back to the hub's ambient AWS identity for project-authored configuration.
		const credentials =
			source.auth.method === 'static'
				? {
						accessKeyId: source.auth.access_key_id,
						secretAccessKey: source.auth.secret_access_key,
						sessionToken: source.auth.session_token,
					}
				: options.federatedCredentials;
		// A caller-owned cancellation must not abort another start's shared mint.
		if (options.signal) return this.mint(source, options, credentials);
		// Include secret rotation without retaining plaintext credentials in cache keys.
		const identity = await sha256Hex(
			JSON.stringify([
				credentials?.accessKeyId,
				credentials?.secretAccessKey,
				credentials?.sessionToken,
			]),
		);
		const key = JSON.stringify([
			source.region,
			source.domain,
			source.domain_owner,
			source.auth.method,
			identity,
		]);
		const hit = this.tokens.get(key);
		if (hit && hit.expiresAt - Date.now() >= MIN_REMAINING_MS) {
			const token = await hit.token;
			logEvent({
				level: 'debug',
				event: 'codeartifact_token_cache_hit',
				remaining_lifetime_ms: Date.parse(token.expiresAt) - Date.now(),
			});
			return { ...token };
		}
		const entry: TokenEntry = {
			expiresAt: Infinity,
			token: this.mint(source, options, credentials).then((token) => {
				entry.expiresAt = Date.parse(token.expiresAt);
				return token;
			}),
		};
		entry.token.catch(() => {
			if (this.tokens.peek(key) === entry) this.tokens.delete(key);
		});
		this.tokens.set(key, entry);
		return { ...(await entry.token) };
	}

	private async mint(
		source: CodeArtifactSource,
		options: ResolveOptions,
		credentials: TempS3Creds | undefined,
	) {
		let signal = options.signal;
		try {
			options.signal?.throwIfAborted();
			if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
				throw new Error('Missing AWS credentials');
			}
			if (!AWS_REGION_NAME_REGEX.test(source.region)) throw new Error('Invalid region');
			const hostname = `codeartifact.${source.region}.${awsDnsSuffix(source.region)}`;
			const query = {
				domain: source.domain,
				'domain-owner': source.domain_owner,
				duration: String(TOKEN_DURATION_SECONDS),
			};
			const deadline = AbortSignal.timeout(10_000);
			signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
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
		} catch (error) {
			const cause = signal?.aborted ? signal.reason : error;
			if (
				signal?.aborted ||
				(cause instanceof DOMException && ['AbortError', 'TimeoutError'].includes(cause.name))
			) {
				const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
				throw new DOMException(
					timedOut
						? 'CodeArtifact authentication timed out.'
						: 'CodeArtifact authentication cancelled.',
					timedOut ? 'TimeoutError' : 'AbortError',
				);
			}
			throw new UnavailableError(
				'CodeArtifact authentication failed. Check the AWS credentials, region, domain, and IAM permissions.',
			);
		}
	}
}
