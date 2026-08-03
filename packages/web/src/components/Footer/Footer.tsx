import type { ReactNode } from 'react';
import { Info, ExternalLink } from 'lucide-react';
import { useCapabilitiesQuery, useVersionQuery } from '@/api/hooks';
import { Popover } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { formatRelative } from '@/lib/time';

/** Source repository — the UI derives release/commit + issue links from it. */
const SOURCE_URL = 'https://github.com/marimo-team/marimohub';

/**
 * MARIMOHUB_VERSION is either a release tag (`0.2.0`) or a git SHA (`a1b2c3d`);
 * only one of those has a release page, so pick the GitHub URL per shape. Any
 * other value (e.g. `dev`) has no page at all.
 */
function versionHref(version: string): string | null {
	if (/^v?\d+\.\d+\.\d+/.test(version)) {
		return `${SOURCE_URL}/releases/tag/${version.startsWith('v') ? version : `v${version}`}`;
	}
	if (/^[0-9a-f]{7,40}$/i.test(version)) {
		return `${SOURCE_URL}/commit/${version}`;
	}
	return null;
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all text-foreground">{value}</dd>
		</>
	);
}

/** A timestamp shown as a relative phrase, with the exact value on hover. */
function Timestamp({ iso }: { iso: string }) {
	return (
		<time dateTime={iso} title={iso} className="tabular-nums">
			{formatRelative(iso) || iso}
		</time>
	);
}

/**
 * Slim bottom bar with a single info affordance: clicking it opens a popover with
 * the deployment's version, image, start time, replica, runtime, and active
 * backends (from `GET /api/v1/version`). Super admins additionally see the
 * deployment policy (from `GET /api/v1/capabilities`). The bar renders even while
 * the queries are in flight or have failed — the popover just shows what's known —
 * so it never blocks or shifts the layout.
 */
export function Footer() {
	const { data: v } = useVersionQuery();
	const { user } = useAuth();
	const isSuperAdmin = user?.is_super_admin ?? false;
	const { data: caps } = useCapabilitiesQuery(isSuperAdmin);

	const href = v ? versionHref(v.version) : null;
	const versionValue = href ? (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
		>
			<span className="tabular-nums">{v!.version}</span>
			<ExternalLink className="size-3 shrink-0 text-muted-foreground" />
		</a>
	) : (
		<span className="tabular-nums">{v?.version ?? 'unknown'}</span>
	);

	return (
		<footer className="flex shrink-0 items-center justify-between border-t bg-background px-4 py-2 max-md:px-3">
			<span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground/60">
				MARIMOHUB
			</span>
			<Popover
				label="Version info"
				placement="top end"
				trigger={<Info className="size-3.5" />}
				triggerClassName="rounded-full text-muted-foreground transition-colors hover:text-foreground"
			>
				<div className="flex min-w-[16rem] flex-col gap-2 text-xs">
					<div className="font-medium text-foreground">marimohub</div>
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
						<InfoRow label="Version" value={versionValue} />
						{v?.image && <InfoRow label="Image" value={v.image} />}
						{v?.sandbox_image && <InfoRow label="Sandbox image" value={v.sandbox_image} />}
						{v?.started_at && <InfoRow label="Started" value={<Timestamp iso={v.started_at} />} />}
						{v?.replica && <InfoRow label="Replica" value={v.replica} />}
						{v?.node && (
							<InfoRow label="Node" value={<span className="tabular-nums">{v.node}</span>} />
						)}
						{v?.backends && (
							<InfoRow
								label="Backends"
								value={
									<span className="tabular-nums">
										{v.backends.storage} · {v.backends.compute} · {v.backends.auth}
									</span>
								}
							/>
						)}
					</dl>
					{isSuperAdmin && caps && (
						<div className="border-t pt-2">
							<div className="mb-1 font-medium text-foreground">Policy</div>
							<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
								<InfoRow label="Viewer mode" value={caps.viewer_mode} />
								<InfoRow label="Sandbox sharing" value={caps.editor_sandbox_sharing} />
								<InfoRow label="Default role" value={caps.default_role ?? 'members only'} />
								<InfoRow
									label="Features"
									value={
										[
											caps.federation.available && 'federation',
											caps.integrations.available && 'integrations',
										]
											.filter(Boolean)
											.join(' · ') || 'none'
									}
								/>
								<InfoRow
									label="Limits"
									value={
										<span className="tabular-nums">
											{caps.limits.max_concurrent_sessions_per_user ?? '∞'} sessions/user ·{' '}
											{caps.limits.max_apps_per_project ?? '∞'} apps/project ·{' '}
											{caps.limits.max_versions_per_notebook} versions/notebook
										</span>
									}
								/>
								{caps.sandbox_images.length > 0 && (
									<InfoRow label="Images" value={caps.sandbox_images.join(', ')} />
								)}
								{caps.compute_profiles.length > 0 && (
									<InfoRow
										label="Profiles"
										value={
											caps.compute_profiles.map((p) => p.name).join(' · ') +
											(caps.compute_profile_override === 'none'
												? ''
												: ` (override: ${caps.compute_profile_override})`)
										}
									/>
								)}
							</dl>
						</div>
					)}
					<div className="flex gap-3 border-t pt-2 text-muted-foreground">
						<a
							href={SOURCE_URL}
							target="_blank"
							rel="noreferrer"
							className="underline-offset-4 hover:text-foreground hover:underline"
						>
							Source
						</a>
						<a
							href={`${SOURCE_URL}/issues`}
							target="_blank"
							rel="noreferrer"
							className="underline-offset-4 hover:text-foreground hover:underline"
						>
							Report an issue
						</a>
					</div>
				</div>
			</Popover>
		</footer>
	);
}
