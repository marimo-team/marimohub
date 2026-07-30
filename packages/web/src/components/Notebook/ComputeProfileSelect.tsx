import { AlertTriangle, Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Capabilities, Session } from '@/types';

export type ComputeProfile = Capabilities['compute_profiles'][number];
export type ComputeProfileResources = NonNullable<Session['compute_resources']>;

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

export function computeResourcesEqual(
	left: ComputeProfileResources | undefined,
	right: ComputeProfileResources | undefined,
): boolean {
	if (!left || !right) return true;
	return left.cpu === right.cpu && left.memory_bytes === right.memory_bytes;
}

export function ComputeProfileIndicator({
	profiles,
	storedName,
	allowOverride,
	hint,
	className,
}: {
	profiles: ComputeProfile[];
	storedName?: string;
	allowOverride: boolean;
	hint?: string;
	className?: string;
}) {
	const profile = effectiveComputeProfile(profiles, storedName, allowOverride);
	if (!profile) return null;
	const unavailable =
		allowOverride && !!storedName && !profiles.some((item) => item.name === storedName);
	const label = unavailable
		? `${storedName} (unavailable) → using ${computeProfileLabel(profile, true)}`
		: computeProfileLabel(profile, profile.name === profiles[0]?.name && !storedName);

	return (
		<span
			className={cn(
				'inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground',
				className,
			)}
			title={unavailable ? 'This profile was removed by your operator.' : hint}
		>
			{unavailable ? (
				<AlertTriangle className="size-3 shrink-0 text-amber-600 dark:text-amber-500" />
			) : (
				<Cpu className="size-3 shrink-0" />
			)}
			<span className="truncate">{label}</span>
		</span>
	);
}
