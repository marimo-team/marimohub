import type { ComputeResources } from '@marimo-hub/core';
import { ConfigError } from './errors';

export type { ComputeResources } from '@marimo-hub/core';

export interface ComputeProfile {
	readonly name: string;
	readonly resources: ComputeResources;
}

export interface ComputeProfilesConfig {
	readonly profiles: readonly ComputeProfile[];
	readonly defaultProfile: ComputeProfile | undefined;
}

export type ComputeProfileOverride = 'none' | 'editors';

export class ComputeProfileConfigError extends ConfigError {
	constructor(
		message: string,
		readonly profileName?: string,
		readonly key?: string,
	) {
		const where =
			profileName !== undefined
				? ` (profile ${JSON.stringify(profileName)}${key ? `, key ${JSON.stringify(key)}` : ''})`
				: '';
		super(`MARIMOHUB_COMPUTE_PROFILES: ${message}${where}`, {
			variable: 'MARIMOHUB_COMPUTE_PROFILES',
			remediation: 'Use name:cpu=<cores>;mem=<Mi|Gi|Ti>, with lowercase names and unique keys.',
			docs: 'docs/configuration.md#compute',
		});
	}
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const KNOWN_KEYS = new Set(['cpu', 'mem']);
const MEM_RE = /^(\d+(?:\.\d+)?)(Mi|Gi|Ti)$/;
const MEM_MULTIPLIER: Record<string, number> = {
	Mi: 1024 ** 2,
	Gi: 1024 ** 3,
	Ti: 1024 ** 4,
};
const MAX_CPU_CORES = 4096;
const MAX_MEMORY_BYTES = 64 * 1024 ** 4;
const MIN_CPU_CORES = 0.001;
const MIN_MEMORY_BYTES = 1024 ** 2;
const PROFILE_BACKENDS = new Set(['docker', 'podman', 'kubernetes', 'modal', 'coreweave', 'wandb']);

export function supportsComputeProfiles(backend: string): boolean {
	return PROFILE_BACKENDS.has(backend);
}

function parseCpu(value: string, profile: string): number {
	if (!/^\d+(?:\.\d+)?$/.test(value)) {
		throw new ComputeProfileConfigError(
			`cpu must be a positive decimal core count, got ${JSON.stringify(value)}`,
			profile,
			'cpu',
		);
	}
	const cpu = Number(value);
	if (!Number.isFinite(cpu) || cpu < MIN_CPU_CORES) {
		throw new ComputeProfileConfigError(
			`cpu must be at least ${MIN_CPU_CORES} cores, got ${JSON.stringify(value)}`,
			profile,
			'cpu',
		);
	}
	if (cpu > MAX_CPU_CORES) {
		throw new ComputeProfileConfigError(
			`cpu=${value} exceeds sanity limit of ${MAX_CPU_CORES} cores`,
			profile,
			'cpu',
		);
	}
	return cpu;
}

function parseMem(value: string, profile: string): number {
	const match = MEM_RE.exec(value);
	if (!match) {
		if (/^\d+(?:\.\d+)?$/.test(value)) {
			throw new ComputeProfileConfigError(
				`mem requires an explicit binary unit (Mi, Gi, Ti); bare number ${JSON.stringify(value)} is ambiguous`,
				profile,
				'mem',
			);
		}
		if (/^\d+(?:\.\d+)?\s*(B|KB|MB|GB|TB|K|M|G|T|MiB|GiB|TiB)$/i.test(value)) {
			throw new ComputeProfileConfigError(
				`mem uses binary units Mi, Gi, or Ti exactly (e.g. "4Gi"), got ${JSON.stringify(value)}`,
				profile,
				'mem',
			);
		}
		throw new ComputeProfileConfigError(
			`mem must match <number><Mi|Gi|Ti>, got ${JSON.stringify(value)}`,
			profile,
			'mem',
		);
	}
	const bytes = Number(match[1]) * MEM_MULTIPLIER[match[2]];
	if (!Number.isFinite(bytes) || bytes < MIN_MEMORY_BYTES) {
		throw new ComputeProfileConfigError(
			`mem must be at least 1Mi, got ${JSON.stringify(value)}`,
			profile,
			'mem',
		);
	}
	if (bytes > MAX_MEMORY_BYTES) {
		throw new ComputeProfileConfigError(
			`mem=${value} exceeds sanity limit of 64Ti`,
			profile,
			'mem',
		);
	}
	return Math.round(bytes);
}

function parseOneProfile(chunk: string, index: number): ComputeProfile {
	const colon = chunk.indexOf(':');
	const name = (colon === -1 ? chunk : chunk.slice(0, colon)).trim();
	const body = colon === -1 ? '' : chunk.slice(colon + 1).trim();

	if (name.length === 0) {
		throw new ComputeProfileConfigError(`profile at position ${index + 1} has an empty name`);
	}
	if (!NAME_RE.test(name)) {
		throw new ComputeProfileConfigError(
			`invalid profile name ${JSON.stringify(name)}; must match [a-z0-9-]{1,32}`,
			name,
		);
	}

	let cpu: number | undefined;
	let memoryBytes: number | undefined;
	const seen = new Set<string>();
	if (body.length > 0) {
		for (const rawPair of body.split(';')) {
			const pair = rawPair.trim();
			if (pair.length === 0) continue;
			const equals = pair.indexOf('=');
			if (equals === -1) {
				throw new ComputeProfileConfigError(
					`expected key=value, got ${JSON.stringify(pair)}`,
					name,
				);
			}
			const key = pair.slice(0, equals).trim();
			const value = pair.slice(equals + 1).trim();
			if (!KNOWN_KEYS.has(key)) {
				throw new ComputeProfileConfigError(
					`unknown key ${JSON.stringify(key)}; supported keys: ${[...KNOWN_KEYS].join(', ')}`,
					name,
					key,
				);
			}
			if (seen.has(key)) throw new ComputeProfileConfigError('duplicate key', name, key);
			seen.add(key);
			if (value.length === 0) throw new ComputeProfileConfigError('empty value', name, key);
			if (key === 'cpu') cpu = parseCpu(value, name);
			if (key === 'mem') memoryBytes = parseMem(value, name);
		}
	}

	return {
		name,
		resources: {
			...(cpu !== undefined ? { cpu } : {}),
			...(memoryBytes !== undefined ? { memoryBytes } : {}),
		},
	};
}

export function parseComputeProfiles(raw: string | undefined): ComputeProfilesConfig {
	if (raw === undefined || raw.trim().length === 0) {
		return { profiles: [], defaultProfile: undefined };
	}
	const chunks = raw.split(',').map((chunk) => chunk.trim());
	const emptyIndex = chunks.findIndex((chunk) => chunk.length === 0);
	if (emptyIndex !== -1) {
		throw new ComputeProfileConfigError(`profile at position ${emptyIndex + 1} has an empty name`);
	}

	const profiles = chunks.map(parseOneProfile);
	const names = new Set<string>();
	for (const profile of profiles) {
		if (names.has(profile.name)) {
			throw new ComputeProfileConfigError('duplicate profile name', profile.name);
		}
		names.add(profile.name);
	}
	return { profiles, defaultProfile: profiles[0] };
}

export function resolveResources(config: ComputeProfilesConfig): ComputeResources {
	return config.defaultProfile?.resources ?? {};
}

export function parseComputeProfileOverride(raw: string | undefined): ComputeProfileOverride {
	if (raw === undefined || raw.trim() === '' || raw === 'none') return 'none';
	if (raw === 'editors') return 'editors';
	throw new ConfigError(
		`Invalid MARIMOHUB_COMPUTE_PROFILE_OVERRIDE: ${raw} (expected none or editors)`,
		{
			variable: 'MARIMOHUB_COMPUTE_PROFILE_OVERRIDE',
			remediation: 'Use none or editors.',
			docs: 'docs/configuration.md#compute',
		},
	);
}

export function hasConfiguredResources(config: ComputeProfilesConfig): boolean {
	return config.profiles.some(
		(profile) => profile.resources.cpu !== undefined || profile.resources.memoryBytes !== undefined,
	);
}

export function unsupportedBackendNotice(
	backend: string,
	config: ComputeProfilesConfig,
): string | undefined {
	if (supportsComputeProfiles(backend) || !hasConfiguredResources(config)) return undefined;
	const backendConfigHint =
		backend === 'e2b' || backend === 'cloudflare'
			? ' Backend-specific MARIMOHUB_COMPUTE_* settings remain authoritative.'
			: '';
	return (
		`MARIMOHUB_COMPUTE_PROFILES is set but the ${JSON.stringify(backend)} compute backend ` +
		`does not apply cpu/mem profiles; profiles are ignored.${backendConfigHint}`
	);
}
