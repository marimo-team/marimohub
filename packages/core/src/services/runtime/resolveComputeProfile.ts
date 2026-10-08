import type { ComputeResources } from '../../ports/sandbox';
import type { ComputeResourceRecord } from '../../schema';

export interface ComputeProfileConfig {
	/** Name of the default compute profile. */
	computeProfile?: string;
	editComputeProfile?: string;
	appComputeProfile?: string;
	/** Ordered profiles available to provisioning; the first is the default. */
	computeProfiles?: { name: string; resources: ComputeResources }[];
	/** Resources from the deployment's default compute profile. */
	resources?: ComputeResources;
}

export interface ResolvedComputeProfile {
	name: string | undefined;
	resources: ComputeResources;
}

/**
 * The profile a sandbox provisions with: the notebook's stored choice when
 * editors may override and it is still configured, else the deployment default.
 * Session modes may select different defaults; jobs keep the deployment default.
 * A stored profile the operator removed falls back
 * (and reports it) rather than failing the launch.
 */
export function resolveComputeProfile(
	config: ComputeProfileConfig,
	storedName: string | undefined,
	allowOverride: boolean,
	onFallback: (message: string) => void,
	mode?: 'edit' | 'app',
): ResolvedComputeProfile {
	const modeDefault =
		mode === 'edit'
			? config.editComputeProfile
			: mode === 'app'
				? config.appComputeProfile
				: undefined;
	const fallback = config.computeProfiles?.find((profile) => profile.name === modeDefault) ??
		config.computeProfiles?.[0] ?? {
			name: config.computeProfile,
			resources: config.resources ?? {},
		};
	if (!allowOverride || !storedName) return fallback;
	const selected = config.computeProfiles?.find((profile) => profile.name === storedName);
	if (selected) return selected;
	onFallback(
		`Compute profile "${storedName}" is no longer configured; using default "${fallback.name ?? 'adapter default'}"`,
	);
	return fallback;
}

/** The persisted shape of a sandbox's resources (session and run records). */
export function toComputeResourceRecord(
	resources: ComputeResources | undefined,
): ComputeResourceRecord | undefined {
	if (!resources) return undefined;
	return {
		cpu: resources.cpu,
		memory_bytes: resources.memoryBytes,
		gpu: resources.gpu,
	};
}
