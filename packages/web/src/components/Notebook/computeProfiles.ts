import type { RadioGroupFieldOption } from '@/components/form/fields/RadioGroupField';
import type { Capabilities, Session } from '@/types';

export const DEFAULT_COMPUTE_PROFILE = '__marimohub_default_compute__';

export type ComputeProfile = Capabilities['compute_profiles'][number];
export type ComputeProfileResources = NonNullable<Session['compute_resources']>;
export type ComputeResourceComparison = 'same' | 'different' | 'unknown';
export type ComputePendingReason = 'profile' | 'resources' | 'snapshot' | 'unknown';

export interface ComputeSessionPresentation {
	runningLabel?: string;
	selectedLabel?: string;
	pending: boolean;
	pendingReason?: ComputePendingReason;
	pendingMessage?: string;
	snapshotMessage?: string;
}

function formatMemory(bytes: number): string {
	const units = [
		{ label: 'Ti', bytes: 1024 ** 4 },
		{ label: 'Gi', bytes: 1024 ** 3 },
		{ label: 'Mi', bytes: 1024 ** 2 },
	];
	const unit = units.find((candidate) => bytes >= candidate.bytes) ?? units[2];
	const value = bytes / unit.bytes;
	return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit.label}`;
}

export function computeProfileResources(
	profile: Pick<ComputeProfile, 'cpu' | 'memory_bytes'> | ComputeProfileResources,
): string {
	const resources = [
		profile.cpu === undefined ? undefined : `${profile.cpu} CPU`,
		profile.memory_bytes === undefined ? undefined : formatMemory(profile.memory_bytes),
	].filter((value): value is string => value !== undefined);
	return resources.length > 0 ? resources.join(' · ') : 'platform default';
}

export function computeProfileLabel(profile: ComputeProfile, isDefault = false): string {
	const name = isDefault ? `Default (${profile.name})` : profile.name;
	return `${name} — ${computeProfileResources(profile)}`;
}

export function effectiveComputeProfile(
	profiles: ComputeProfile[],
	storedName: string | undefined,
	allowOverride: boolean,
): ComputeProfile | undefined {
	if (!allowOverride || !storedName) return profiles[0];
	return profiles.find((profile) => profile.name === storedName) ?? profiles[0];
}

export function computeProfilePickerValue(
	profiles: ComputeProfile[],
	storedName: string | undefined,
): string {
	return !storedName || storedName === profiles[0]?.name ? DEFAULT_COMPUTE_PROFILE : storedName;
}

export function computeProfileOptions(
	profiles: ComputeProfile[],
	staleName?: string,
): RadioGroupFieldOption[] {
	const defaultProfile = profiles[0];
	if (!defaultProfile) return [];
	const staleOption =
		staleName && !profiles.some((profile) => profile.name === staleName)
			? {
					value: staleName,
					label: `${staleName} (unavailable)`,
					description: 'Removed by your operator',
					isDisabled: true,
				}
			: undefined;
	return [
		{
			value: DEFAULT_COMPUTE_PROFILE,
			label: `Default (${defaultProfile.name})`,
			description: computeProfileResources(defaultProfile),
		},
		...profiles.slice(1).map((profile) => ({
			value: profile.name,
			label: profile.name,
			description: computeProfileResources(profile),
		})),
		...(staleOption ? [staleOption] : []),
	];
}

export function compareComputeResources(
	left: ComputeProfileResources | undefined,
	right: ComputeProfileResources | undefined,
): ComputeResourceComparison {
	if (!left || !right) return 'unknown';
	return left.cpu === right.cpu && left.memory_bytes === right.memory_bytes ? 'same' : 'different';
}

export function computeSessionPresentation(
	session: Pick<Session, 'compute_profile' | 'compute_resources' | 'compute_from_snapshot'>,
	profiles: ComputeProfile[],
	selectedProfile: ComputeProfile | undefined,
): ComputeSessionPresentation {
	if (!selectedProfile || profiles.length === 0) {
		return {
			pending: false,
			snapshotMessage: session.compute_from_snapshot ? 'running from snapshot' : undefined,
		};
	}

	const runningName = session.compute_profile;
	const runningResources = session.compute_resources;
	const resourceComparison = compareComputeResources(runningResources, selectedProfile);
	let pendingReason: ComputePendingReason | undefined;
	if (!runningName) {
		pendingReason = 'unknown';
	} else if (runningName !== selectedProfile.name) {
		pendingReason = 'profile';
	} else if (resourceComparison === 'different') {
		pendingReason = 'resources';
	} else if (resourceComparison === 'unknown') {
		pendingReason = 'unknown';
	}
	if (pendingReason && session.compute_from_snapshot) pendingReason = 'snapshot';

	const runningLabel = runningName
		? `${runningName} — ${
				runningResources ? computeProfileResources(runningResources) : 'resources unavailable'
			}`
		: 'resources unavailable';
	const selectedLabel = `${selectedProfile.name} — ${computeProfileResources(selectedProfile)}`;
	const pendingMessage =
		pendingReason === 'resources'
			? 'profile updated — restart to apply'
			: pendingReason === 'unknown'
				? 'running resources unknown — restart to apply'
				: pendingReason === 'profile'
					? `${selectedProfile.name} on next restart`
					: undefined;
	const snapshotMessage = session.compute_from_snapshot
		? pendingReason
			? 'applies after snapshot is dropped'
			: 'running from snapshot'
		: undefined;

	return {
		runningLabel,
		selectedLabel,
		pending: pendingReason !== undefined,
		pendingReason,
		pendingMessage,
		snapshotMessage,
	};
}
