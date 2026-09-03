import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { V1Secret } from '@kubernetes/client-node';
import { SecretResolutionError } from '@marimo-hub/core';
import type { SecretRef, SecretResolutionContext, SecretResolver } from '@marimo-hub/core';
import { loadKubernetesConfiguration } from './kubeConfig';
import {
	isValidKubernetesNamespace,
	isValidKubernetesSecretName,
	parseKubernetesSecretPolicies,
} from './policy';
import type { KubernetesSecretPolicy } from './policy';

export {
	isValidKubernetesNamespace,
	isValidKubernetesSecretName,
	parseKubernetesSecretPolicies,
} from './policy';
export type { KubernetesSecretPolicy } from './policy';

export const INTEGRATION_SECRET_LABEL = 'marimohub.io/integration-secret';

export interface KubernetesSecretSnapshot {
	metadata?: {
		labels?: Record<string, string>;
		resourceVersion?: string;
	};
	data?: Record<string, string>;
}

export type KubernetesSecretFetcher = (
	namespace: string,
	name: string,
) => Promise<KubernetesSecretSnapshot>;

export interface KubernetesSecretResolverOptions {
	fetch: KubernetesSecretFetcher;
	allowedSecrets: readonly KubernetesSecretPolicy[];
	cacheTtlMs?: number;
	now?: () => number;
}

interface AllowedSecret {
	projects: '*' | ReadonlySet<string>;
}

interface CacheEntry {
	secret: KubernetesSecretSnapshot;
	expires: number;
}

export class KubernetesSecretResolver implements SecretResolver {
	readonly backend = 'k8s';
	readonly title = 'Kubernetes Secret';
	readonly locatorPlaceholder = 'namespace/secret-name#data-key';
	readonly locatorHelp =
		'Use namespace/secret-name#data-key. The Secret must be explicitly allowed by the deployment.';
	readonly docsUrl =
		'https://github.com/marimo-team/marimo-hub/blob/main/docs/integration-secrets.md#kubernetes-secrets';

	private readonly fetch: KubernetesSecretFetcher;
	private readonly allowedSecrets: ReadonlyMap<string, AllowedSecret>;
	private readonly cacheTtlMs: number;
	private readonly now: () => number;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly operationCache = new WeakMap<
		SecretResolutionContext,
		Map<string, Promise<KubernetesSecretSnapshot>>
	>();

	constructor(options: KubernetesSecretResolverOptions) {
		if (
			options.cacheTtlMs !== undefined &&
			(!Number.isSafeInteger(options.cacheTtlMs) || options.cacheTtlMs < 0)
		) {
			throw new Error('Kubernetes Secret cache TTL must be a non-negative safe integer.');
		}
		this.fetch = options.fetch;
		this.allowedSecrets = new Map(
			parseKubernetesSecretPolicies(options.allowedSecrets).map((rule) => [
				secretCacheKey(rule.namespace, rule.name),
				{ projects: rule.projects === '*' ? '*' : new Set(rule.projects) },
			]),
		);
		this.cacheTtlMs = options.cacheTtlMs ?? 0;
		this.now = options.now ?? (() => Date.now());
	}

	async resolve(ref: SecretRef, context: SecretResolutionContext): Promise<string> {
		const locator = parseKubernetesSecretLocator(ref.locator);
		const policy = this.allowedSecrets.get(secretCacheKey(locator.namespace, locator.name));
		if (!policy) {
			throw new SecretResolutionError(
				'forbidden',
				'Kubernetes Secret is not allowed by the deployment.',
			);
		}
		assertOwnerAuthorized(policy, context);

		const cacheKey = secretCacheKey(locator.namespace, locator.name);
		try {
			const secret = await this.fetchForOperation(context, locator.namespace, locator.name);
			assertOptedIn(secret);
			const encoded = secret.data?.[locator.key];
			if (encoded === undefined) {
				throw new SecretResolutionError(
					'invalid_value',
					'Kubernetes Secret does not contain the requested data key.',
				);
			}
			return decodeSecretValue(encoded);
		} catch (error) {
			this.cache.delete(cacheKey);
			this.operationCache.get(context)?.delete(cacheKey);
			throw error;
		}
	}

	private fetchForOperation(
		context: SecretResolutionContext,
		namespace: string,
		name: string,
	): Promise<KubernetesSecretSnapshot> {
		let operation = this.operationCache.get(context);
		if (!operation) {
			operation = new Map();
			this.operationCache.set(context, operation);
		}
		const cacheKey = secretCacheKey(namespace, name);
		const hit = operation.get(cacheKey);
		if (hit) return hit;

		const pending = this.fetchCached(cacheKey, namespace, name).catch((error: unknown) => {
			operation?.delete(cacheKey);
			throw error;
		});
		operation.set(cacheKey, pending);
		return pending;
	}

	private async fetchCached(
		cacheKey: string,
		namespace: string,
		name: string,
	): Promise<KubernetesSecretSnapshot> {
		if (this.cacheTtlMs > 0) {
			const hit = this.cache.get(cacheKey);
			if (hit && hit.expires > this.now()) return hit.secret;
		}

		let secret: KubernetesSecretSnapshot;
		try {
			secret = await this.fetch(namespace, name);
		} catch (error) {
			const status = kubernetesStatus(error);
			const reason =
				status === 404
					? 'not_found'
					: status === 401 || status === 403
						? 'forbidden'
						: 'unavailable';
			throw new SecretResolutionError(reason, 'Kubernetes Secret resolution failed.');
		}

		if (this.cacheTtlMs > 0) {
			this.cache.set(cacheKey, { secret, expires: this.now() + this.cacheTtlMs });
		}
		return secret;
	}
}

export interface CreateKubernetesSecretResolverOptions {
	allowedSecrets: readonly KubernetesSecretPolicy[];
	cacheTtlMs?: number;
}

export function createKubernetesSecretResolver(
	options: CreateKubernetesSecretResolverOptions,
): KubernetesSecretResolver {
	const config = new KubeConfig();
	loadKubernetesConfiguration(config);
	const client = config.makeApiClient(CoreV1Api);
	return new KubernetesSecretResolver({
		allowedSecrets: options.allowedSecrets,
		cacheTtlMs: options.cacheTtlMs,
		fetch: async (namespace, name) => {
			const secret: V1Secret = await client.readNamespacedSecret({ namespace, name });
			return secret;
		},
	});
}

export function parseKubernetesSecretLocator(locator: string): {
	namespace: string;
	name: string;
	key: string;
} {
	const hash = locator.lastIndexOf('#');
	if (hash <= 0 || hash === locator.length - 1) invalidLocator();
	const object = locator.slice(0, hash);
	const slash = object.indexOf('/');
	if (slash <= 0 || slash !== object.lastIndexOf('/') || slash === object.length - 1) {
		invalidLocator();
	}
	const namespace = object.slice(0, slash);
	const name = object.slice(slash + 1);
	const key = locator.slice(hash + 1);
	if (
		!isValidKubernetesNamespace(namespace) ||
		!isValidKubernetesSecretName(name) ||
		key.length > 253 ||
		!/^[A-Za-z0-9._-]+$/.test(key)
	) {
		invalidLocator();
	}
	return { namespace, name, key };
}

function invalidLocator(): never {
	throw new SecretResolutionError(
		'invalid_value',
		'Invalid Kubernetes Secret locator; expected namespace/secret-name#data-key.',
	);
}

function assertOptedIn(secret: KubernetesSecretSnapshot): void {
	if (secret.metadata?.labels?.[INTEGRATION_SECRET_LABEL] !== 'true') {
		throw new SecretResolutionError(
			'forbidden',
			'Kubernetes Secret is not labeled for integration use.',
		);
	}
}

function assertOwnerAuthorized(policy: AllowedSecret, context: SecretResolutionContext): void {
	if (policy.projects === '*') return;
	if (context.scope === 'org') {
		throw new SecretResolutionError(
			'forbidden',
			'Kubernetes Secret is not available to organization integrations.',
		);
	}

	if (!policy.projects.has(context.projectId)) {
		throw new SecretResolutionError(
			'forbidden',
			'Kubernetes Secret is not available to the integration project.',
		);
	}
}

function secretCacheKey(namespace: string, name: string): string {
	return `${namespace}\0${name}`;
}

function decodeSecretValue(encoded: string): string {
	if (
		encoded.length === 0 ||
		encoded.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
	) {
		return invalidSecretData();
	}
	const bytes = Buffer.from(encoded, 'base64');
	if (bytes.toString('base64') !== encoded) return invalidSecretData();
	let value: string;
	try {
		value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return invalidSecretData();
	}
	if (value.length === 0) return invalidSecretData();
	return value;
}

function invalidSecretData(): never {
	throw new SecretResolutionError(
		'invalid_value',
		'Kubernetes Secret data value must be non-empty base64-encoded UTF-8.',
	);
}

function kubernetesStatus(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const candidate = error as {
		code?: unknown;
		statusCode?: unknown;
		body?: { code?: unknown };
	};
	for (const value of [candidate.code, candidate.statusCode, candidate.body?.code]) {
		if (typeof value === 'number') return value;
	}
	return undefined;
}
