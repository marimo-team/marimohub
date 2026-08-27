import type { Bucket } from './bucket';
import type { SandboxInstance, SandboxProvider } from './sandbox';

export const BUCKET_REQUIRED_METHODS = [
	'get',
	'head',
	'put',
	'delete',
	'list',
] as const satisfies readonly (keyof Bucket)[];

export const SANDBOX_PROVIDER_REQUIRED_METHODS = [
	'create',
	'proxy',
] as const satisfies readonly (keyof SandboxProvider)[];

export const SANDBOX_INSTANCE_REQUIRED_METHODS = [
	'exec',
	'execStream',
	'readFile',
	'listFiles',
	'writeFiles',
	'gitCheckout',
	'setEnvVars',
	'mountBucket',
	'unmountBucket',
	'startProcess',
	'exposePort',
	'destroy',
] as const satisfies readonly (keyof SandboxInstance)[];

export const SANDBOX_INSTANCE_OPTIONAL_METHODS = [
	'ready',
	'launchProcess',
	'drainTimings',
	'drainCounters',
] as const satisfies readonly (keyof SandboxInstance)[];

function missingMethods(value: unknown, required: readonly string[]): string[] {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
		return [...required];
	}
	const shape = value as Record<string, unknown>;
	return required.filter((method) => typeof shape[method] !== 'function');
}

export function missingBucketMethods(value: unknown): string[] {
	return missingMethods(value, BUCKET_REQUIRED_METHODS);
}

export function missingSandboxProviderMethods(value: unknown): string[] {
	return missingMethods(value, SANDBOX_PROVIDER_REQUIRED_METHODS);
}

export function missingSandboxInstanceMethods(value: unknown): string[] {
	return missingMethods(value, SANDBOX_INSTANCE_REQUIRED_METHODS);
}
