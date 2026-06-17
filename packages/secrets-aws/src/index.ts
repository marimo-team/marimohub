/**
 * AWS Secrets Manager resolver — adapter implementing the `SecretResolver` port
 * for `reference`-kind project secrets (`backend = 'aws-sm'`). The hub reads a
 * secret with `GetSecretValue` only; it never writes the customer's manager.
 *
 * A locator is `<secret-id-or-arn>[#<json-key>]`: a bare id returns the secret's
 * string verbatim; a `#key` selects one field of a JSON secret. The resolved
 * value is never logged and never appears in a thrown error.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClientConfig } from '@aws-sdk/client-secrets-manager';
import type { SecretRef, SecretResolver } from '@marimo-hub/core';

/** The raw `GetSecretValue` result the resolver needs — the seam tests fake. */
export interface GetSecretValueResult {
	SecretString?: string;
	SecretBinary?: Uint8Array;
}

/** Fetches one secret by id/ARN. Wraps the SDK; tests supply a fake. */
export type SecretFetcher = (secretId: string) => Promise<GetSecretValueResult>;

export interface AwsSecretsManagerResolverOptions {
	fetch: SecretFetcher;
	/** In-memory cache TTL in ms; `0` (default) disables caching. */
	cacheTtlMs?: number;
	/** Injectable clock for deterministic cache tests. */
	now?: () => number;
}

interface CacheEntry {
	result: GetSecretValueResult;
	expires: number;
}

export class AwsSecretsManagerResolver implements SecretResolver {
	readonly backend = 'aws-sm';
	private readonly fetch: SecretFetcher;
	private readonly cacheTtlMs: number;
	private readonly now: () => number;
	private readonly cache = new Map<string, CacheEntry>();

	constructor(opts: AwsSecretsManagerResolverOptions) {
		this.fetch = opts.fetch;
		this.cacheTtlMs = opts.cacheTtlMs ?? 0;
		this.now = opts.now ?? (() => Date.now());
	}

	async resolve(ref: SecretRef): Promise<string> {
		const { secretId, jsonKey } = parseLocator(ref.locator);
		const result = await this.fetchCached(secretId);

		if (result.SecretString === undefined) {
			if (result.SecretBinary !== undefined) {
				throw new Error(`AWS secret "${secretId}" is binary; only string secrets are supported.`);
			}
			throw new Error(`AWS secret "${secretId}" has no string value.`);
		}

		return jsonKey === undefined
			? result.SecretString
			: selectJsonKey(result.SecretString, jsonKey, secretId);
	}

	/**
	 * Fetch one secret, cached by SECRET ID (not the full locator) so sibling
	 * `#key` selections and a JSON fan-out of the same secret share a single
	 * GetSecretValue call.
	 */
	private async fetchCached(secretId: string): Promise<GetSecretValueResult> {
		if (this.cacheTtlMs > 0) {
			const hit = this.cache.get(secretId);
			if (hit && hit.expires > this.now()) return hit.result;
		}
		let result: GetSecretValueResult;
		try {
			result = await this.fetch(secretId);
		} catch (err) {
			// SDK errors (ResourceNotFound / AccessDenied) carry no secret value.
			throw new Error(`Failed to resolve AWS secret "${secretId}": ${describeAwsError(err)}`);
		}
		if (this.cacheTtlMs > 0) {
			this.cache.set(secretId, { result, expires: this.now() + this.cacheTtlMs });
		}
		return result;
	}
}

/** Split `<id>[#<json-key>]` on the LAST `#` (ids/ARNs carry no `#`). */
function parseLocator(locator: string): { secretId: string; jsonKey?: string } {
	const hash = locator.lastIndexOf('#');
	if (hash === -1) return { secretId: locator };
	return { secretId: locator.slice(0, hash), jsonKey: locator.slice(hash + 1) };
}

/** Parse a JSON secret and return one string field; never leaks the value. */
function selectJsonKey(secretString: string, key: string, secretId: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(secretString);
	} catch {
		throw new Error(`AWS secret "${secretId}" is not JSON, but locator requested key "${key}".`);
	}
	if (typeof parsed !== 'object' || parsed === null || !Object.hasOwn(parsed, key)) {
		throw new Error(`AWS secret "${secretId}" has no JSON key "${key}".`);
	}
	const value = (parsed as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Name of an AWS error without echoing any secret material. */
function describeAwsError(err: unknown): string {
	if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
		return err.name;
	}
	return err instanceof Error ? err.name : 'unknown error';
}

export interface CreateAwsSecretsManagerResolverOptions {
	region?: string;
	credentials?: { accessKeyId: string; secretAccessKey: string };
	cacheTtlMs?: number;
}

/**
 * Build a resolver over a real `SecretsManagerClient`. When `credentials` is
 * omitted the SDK's default provider chain is used (IRSA / ECS task role /
 * instance profile / ambient env), so AWS-hosted deployments need no static key.
 */
export function createAwsSecretsManagerResolver(
	opts: CreateAwsSecretsManagerResolverOptions = {},
): AwsSecretsManagerResolver {
	const config: SecretsManagerClientConfig = {};
	if (opts.region) config.region = opts.region;
	if (opts.credentials) config.credentials = opts.credentials;
	const client = new SecretsManagerClient(config);
	return new AwsSecretsManagerResolver({
		fetch: async (secretId) => {
			const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
			return { SecretString: out.SecretString, SecretBinary: out.SecretBinary };
		},
		cacheTtlMs: opts.cacheTtlMs,
	});
}
