import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	ADAPTER_API_VERSION,
	missingBucketMethods,
	missingSandboxInstanceMethods,
	missingSandboxProviderMethods,
	PreconditionFailedError,
	SANDBOX_INSTANCE_OPTIONAL_METHODS,
} from '@marimo-hub/core';
import type {
	AdapterFactoryContext,
	AdapterModule,
	Bucket,
	ComputeAdapterModule,
	ExternalStorageAdapter,
	SandboxInstance,
	SandboxProvider,
	StorageAdapterModule,
} from '@marimo-hub/core';
import { computeBackend } from './compute';
import { parseSecondsEnv, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError, isConfigError } from './errors';
import type { ConfigErrorOptions } from './errors';
import { DEFAULT_SESSION_IDLE_TIMEOUT_S, DEFAULT_SESSION_MAX_LIFETIME_S } from './sessionDefaults';
import { storageBackend } from './storage';

export interface LoadedAdapterLibraries {
	bucket?: Bucket;
	compute?: SandboxProvider;
}

const ADAPTER_DOCS = 'development_docs/ports.md#external-adapter-libraries';
const LIBRARY_CONFIG = {
	storage: {
		variable: 'MARIMOHUB_STORAGE_LIBRARY',
		label: 'Storage',
		example: '/etc/marimohub/storage.mjs',
	},
	compute: {
		variable: 'MARIMOHUB_COMPUTE_LIBRARY',
		label: 'Compute',
		example: '/etc/marimohub/compute.mjs',
	},
} as const;
type AdapterKind = keyof typeof LIBRARY_CONFIG;
const FACTORY_ERRORS = Object.freeze({
	preconditionFailed: (message?: string) => new PreconditionFailedError(message),
});

function adapterConfigError(
	kind: AdapterKind,
	message: string,
	options: Omit<ConfigErrorOptions, 'variable' | 'docs'> = {},
): ConfigError {
	return new ConfigError(message, {
		variable: LIBRARY_CONFIG[kind].variable,
		docs: ADAPTER_DOCS,
		...options,
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function resolveAdapterSpecifier(specifier: string): string {
	if (specifier.startsWith('file:')) return specifier;
	if (specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)) {
		return pathToFileURL(path.resolve(process.cwd(), specifier)).href;
	}
	return specifier;
}

function unwrapManifest(namespace: unknown): unknown {
	if (!isObject(namespace)) return namespace;
	let manifest = namespace.default ?? namespace;
	if (isObject(manifest) && typeof manifest.create !== 'function' && isObject(manifest.default)) {
		manifest = manifest.default;
	}
	return manifest;
}

function validateManifest(value: unknown, kind: AdapterKind, specifier: string): AdapterModule {
	if (
		!isObject(value) ||
		typeof value.apiVersion !== 'number' ||
		typeof value.kind !== 'string' ||
		typeof value.create !== 'function'
	) {
		throw adapterConfigError(
			kind,
			`"${specifier}" does not default-export a marimohub adapter manifest ({ apiVersion, kind, create })`,
		);
	}
	if (value.kind !== kind) {
		throw adapterConfigError(
			kind,
			`"${specifier}" declares kind "${value.kind}" but was configured as the ${kind} adapter`,
		);
	}
	if (value.apiVersion !== ADAPTER_API_VERSION) {
		throw adapterConfigError(
			kind,
			`"${specifier}" declares adapter apiVersion ${value.apiVersion}; this server supports ${ADAPTER_API_VERSION}`,
		);
	}
	const create = value.create;
	return kind === 'storage'
		? {
				apiVersion: value.apiVersion,
				kind,
				create: create.bind(value) as StorageAdapterModule['create'],
			}
		: {
				apiVersion: value.apiVersion,
				kind,
				create: create.bind(value) as ComputeAdapterModule['create'],
			};
}

interface RequiredShape {
	subject: string;
	contract: string;
	missing(value: unknown): string[];
}

function nonCallableProperties<T extends object>(
	value: T,
	properties: readonly (readonly [PropertyKey, string])[],
): string[] {
	const shape = value as Record<PropertyKey, unknown>;
	return properties.flatMap(([property, name]) => {
		const implementation = shape[property];
		return implementation !== undefined && typeof implementation !== 'function' ? [name] : [];
	});
}

function validateRequiredMethods<T>(
	value: unknown,
	kind: AdapterKind,
	specifier: string,
	shape: RequiredShape,
): T {
	const missing = shape.missing(value);
	if (missing.length > 0) {
		throw adapterConfigError(
			kind,
			`${shape.subject} from "${specifier}" is missing required ${shape.contract} method(s): ${missing.join(', ')}`,
			{
				remediation: `Implement the complete ${shape.contract} port described in development_docs/ports.md.`,
			},
		);
	}
	return value as T;
}

function validateStorage(value: unknown, specifier: string): ExternalStorageAdapter {
	const bucket = validateRequiredMethods<Bucket>(value, 'storage', specifier, {
		subject: 'Storage adapter',
		contract: 'Bucket',
		missing: missingBucketMethods,
	});
	const invalid: string[] = [];
	if (typeof (bucket as Partial<ExternalStorageAdapter>).verifyConditionalWrites !== 'function') {
		invalid.push('verifyConditionalWrites must be a function');
	}
	const casScope = (bucket as Partial<ExternalStorageAdapter>).casScope;
	if (casScope !== 'global' && casScope !== 'process') {
		invalid.push('casScope must be "global" or "process"');
	}
	if (invalid.length > 0) {
		throw adapterConfigError(
			'storage',
			`Storage adapter from "${specifier}" has an invalid CAS safety contract: ${invalid.join('; ')}`,
			{
				remediation:
					'Implement verifyConditionalWrites() and declare whether CAS is global or process-scoped.',
			},
		);
	}
	return bucket as ExternalStorageAdapter;
}

function validateCompute(value: unknown, specifier: string): SandboxProvider {
	const provider = validateRequiredMethods<SandboxProvider>(value, 'compute', specifier, {
		subject: 'Compute adapter',
		contract: 'SandboxProvider',
		missing: missingSandboxProviderMethods,
	});
	const invalidOptional = nonCallableProperties(provider, [
		['listActive', 'listActive'],
		[Symbol.asyncDispose, 'Symbol.asyncDispose'],
	]);
	if (invalidOptional.length > 0) {
		throw adapterConfigError(
			'compute',
			`Compute adapter from "${specifier}" has non-callable optional SandboxProvider method(s): ${invalidOptional.join(', ')}`,
		);
	}
	return validateFirstSandbox(provider, specifier);
}

function validateFirstSandbox(provider: SandboxProvider, specifier: string): SandboxProvider {
	let validated = false;
	const create = provider.create.bind(provider);
	const checkedCreate: SandboxProvider['create'] = (id, options) => {
		const instance = create(id, options);
		if (!validated) {
			validateSandboxInstance(instance, specifier);
			validated = true;
		}
		return instance;
	};
	return new Proxy(provider, {
		get(target, property) {
			if (property === 'create') return checkedCreate;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

function validateSandboxInstance(
	instance: unknown,
	specifier: string,
): asserts instance is SandboxInstance {
	const sandbox = validateRequiredMethods<SandboxInstance>(instance, 'compute', specifier, {
		subject: 'Sandbox instance from compute adapter',
		contract: 'SandboxInstance',
		missing: missingSandboxInstanceMethods,
	});
	const invalidOptional = nonCallableProperties(
		sandbox,
		SANDBOX_INSTANCE_OPTIONAL_METHODS.map((method) => [method, method] as const),
	);
	if (invalidOptional.length > 0) {
		throw adapterConfigError(
			'compute',
			`Sandbox instance from compute adapter "${specifier}" has non-callable optional method(s): ${invalidOptional.join(', ')}`,
		);
	}
	if (
		sandbox.supportsBucketMount !== undefined &&
		typeof sandbox.supportsBucketMount !== 'boolean'
	) {
		throw adapterConfigError(
			'compute',
			`Sandbox instance from compute adapter "${specifier}" has non-boolean supportsBucketMount`,
		);
	}
}

async function loadLibrary(
	kind: AdapterKind,
	specifier: string,
	context: AdapterFactoryContext,
): Promise<Bucket | SandboxProvider> {
	let namespace: unknown;
	try {
		namespace = await import(/* @vite-ignore */ resolveAdapterSpecifier(specifier));
	} catch (error) {
		throw adapterConfigError(
			kind,
			`Could not load ${kind} adapter library "${specifier}": ${errorMessage(error)}`,
			{
				remediation:
					'Install the npm package in the server image, or mount the configured ESM module path.',
			},
		);
	}
	const manifest = validateManifest(unwrapManifest(namespace), kind, specifier);
	let adapter: unknown;
	try {
		adapter = await manifest.create(context);
	} catch (error) {
		throw adapterConfigError(
			kind,
			`${LIBRARY_CONFIG[kind].label} adapter library "${specifier}" failed to initialize: ${errorMessage(error)}`,
		);
	}
	try {
		return kind === 'storage'
			? validateStorage(adapter, specifier)
			: validateCompute(adapter, specifier);
	} catch (error) {
		if (isConfigError(error)) throw error;
		throw adapterConfigError(
			kind,
			`${LIBRARY_CONFIG[kind].label} adapter from "${specifier}" could not be validated: ${errorMessage(error)}`,
		);
	}
}

function adapterContext(env: Env, kind: AdapterKind): AdapterFactoryContext {
	if (kind === 'storage') return { env, errors: FACTORY_ERRORS };
	return {
		env,
		errors: FACTORY_ERRORS,
		compute: {
			sessionMaxLifetimeSeconds:
				parseSecondsEnv(env, 'MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS', {
					dflt: DEFAULT_SESSION_MAX_LIFETIME_S,
				}) / 1_000,
			sessionIdleTimeoutMs: parseSecondsEnv(env, 'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS', {
				dflt: DEFAULT_SESSION_IDLE_TIMEOUT_S,
			}),
		},
	};
}

function requiredLibrarySpecifier(env: Env, kind: AdapterKind): string {
	const config = LIBRARY_CONFIG[kind];
	return requiredVar(env, config.variable, {
		remediation: `Set it to an npm package installed in the image, or a path to an ESM module (e.g. ${config.example}).`,
		docs: ADAPTER_DOCS,
	});
}

function loadSelectedLibrary(
	kind: 'storage',
	selected: boolean,
	env: Env,
): Promise<Bucket | undefined>;
function loadSelectedLibrary(
	kind: 'compute',
	selected: boolean,
	env: Env,
): Promise<SandboxProvider | undefined>;
async function loadSelectedLibrary(
	kind: AdapterKind,
	selected: boolean,
	env: Env,
): Promise<Bucket | SandboxProvider | undefined> {
	if (!selected) return undefined;
	return loadLibrary(kind, requiredLibrarySpecifier(env, kind), adapterContext(env, kind));
}

export async function loadAdapterLibraries(env: Env): Promise<LoadedAdapterLibraries> {
	const storageSelected = storageBackend(env) === 'library';
	const computeSelected = computeBackend(env) === 'library';
	if (!storageSelected && !computeSelected) return {};

	const [bucket, compute] = await Promise.all([
		loadSelectedLibrary('storage', storageSelected, env),
		loadSelectedLibrary('compute', computeSelected, env),
	]);
	return {
		...(bucket ? { bucket } : {}),
		...(compute ? { compute } : {}),
	};
}
