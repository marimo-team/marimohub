import type { Bucket } from './bucket';
import type { SandboxProvider } from './sandbox';
import type { PreconditionFailedError } from '../errors';

export const ADAPTER_API_VERSION = 1;

export interface AdapterFactoryErrors {
	preconditionFailed(message?: string): PreconditionFailedError;
}

export interface AdapterFactoryContext {
	env: Record<string, string | undefined>;
	errors: AdapterFactoryErrors;
	compute?: {
		sessionMaxLifetimeSeconds?: number;
		sessionIdleTimeoutMs?: number;
	};
}

export interface ExternalStorageAdapter extends Bucket {
	readonly casScope: 'global' | 'process';
	verifyConditionalWrites(): Promise<void>;
}

export interface StorageAdapterModule {
	apiVersion: number;
	kind: 'storage';
	create(context: AdapterFactoryContext): ExternalStorageAdapter | Promise<ExternalStorageAdapter>;
}

export interface ComputeAdapterModule {
	apiVersion: number;
	kind: 'compute';
	create(context: AdapterFactoryContext): SandboxProvider | Promise<SandboxProvider>;
}

export type AdapterModule = StorageAdapterModule | ComputeAdapterModule;
