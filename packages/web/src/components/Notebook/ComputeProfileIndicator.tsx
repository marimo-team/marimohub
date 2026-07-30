import { AlertTriangle, Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computeProfileLabel, effectiveComputeProfile } from './computeProfiles';
import type { ComputeProfile } from './computeProfiles';

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
	const followsDefault = !allowOverride || !storedName || storedName === profiles[0]?.name;
	const label = unavailable
		? `${storedName} (unavailable) → using ${computeProfileLabel(profile, true)}`
		: computeProfileLabel(profile, followsDefault);

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
