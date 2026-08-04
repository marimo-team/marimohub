import type { ReactNode } from 'react';
import { ExternalLink, Lock, ShieldCheck } from 'lucide-react';
import { Chip, PageContainer, PageHeader } from '@/components/ui';
import { useDeploymentConfigQuery } from '@/api/hooks';
import { versionHref } from '@/lib/deployment';
import { formatRelative } from '@/lib/time';
import type { DeploymentConfig } from '@/types';

type ConfigSetting = DeploymentConfig['groups'][number]['settings'][number];

function DeploymentRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
			<span className="shrink-0 text-sm font-medium">{label}</span>
			<span className="min-w-0 truncate text-right font-mono text-xs">{value}</span>
		</div>
	);
}

function DeploymentSection({
	deployment,
}: {
	deployment: NonNullable<DeploymentConfig['deployment']>;
}) {
	const href = versionHref(deployment.version);
	return (
		<section className="mb-6">
			<h2 className="mb-2 text-sm font-semibold">Deployment</h2>
			<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DeploymentRow
					label="Version"
					value={
						href ? (
							<a
								href={href}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
							>
								{deployment.version}
								<ExternalLink className="size-3 shrink-0 text-muted-foreground" />
							</a>
						) : (
							deployment.version
						)
					}
				/>
				{deployment.image !== null && (
					<DeploymentRow
						label="Image"
						value={<span title={deployment.image}>{deployment.image}</span>}
					/>
				)}
				{deployment.sandbox_image !== null && (
					<DeploymentRow
						label="Sandbox image"
						value={<span title={deployment.sandbox_image}>{deployment.sandbox_image}</span>}
					/>
				)}
				{deployment.started_at !== null && (
					<DeploymentRow
						label="Started"
						value={
							<time dateTime={deployment.started_at} title={deployment.started_at}>
								{formatRelative(deployment.started_at) || deployment.started_at}
							</time>
						}
					/>
				)}
				{deployment.replica !== null && (
					<DeploymentRow label="Replica" value={deployment.replica} />
				)}
				{deployment.node !== null && <DeploymentRow label="Node runtime" value={deployment.node} />}
				{deployment.backends !== null && (
					<DeploymentRow
						label="Backends"
						value={`${deployment.backends.storage} · ${deployment.backends.compute} · ${deployment.backends.auth}`}
					/>
				)}
			</div>
		</section>
	);
}

function SettingRow({ setting }: { setting: ConfigSetting }) {
	return (
		<div className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm font-medium">{setting.name}</span>
				<span className="truncate font-mono text-xs text-muted-foreground">{setting.key}</span>
			</span>
			{setting.secret ? (
				<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					<Lock className="size-3" />
					{setting.set ? 'Set' : 'Not set'}
				</span>
			) : setting.value === null ? (
				<span className="shrink-0 text-xs text-muted-foreground">Not set</span>
			) : (
				<span className="max-w-[50%] truncate text-right font-mono text-xs">{setting.value}</span>
			)}
		</div>
	);
}

export default function AdminSettingsPage() {
	const { data: config } = useDeploymentConfigQuery();
	const groups = config.groups.filter((group) => group.settings.length > 0);

	return (
		<PageContainer>
			<title>Settings · marimohub</title>
			<PageHeader>
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
					<p className="text-sm text-muted-foreground">
						Read-only deployment configuration — set via MARIMOHUB_* environment variables, read at
						boot. Secrets show only whether they are set.
					</p>
				</div>
			</PageHeader>

			{config.deployment && <DeploymentSection deployment={config.deployment} />}

			<section className="mb-6">
				<h2 className="mb-2 text-sm font-semibold">Access</h2>
				<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
					<div className="flex items-center justify-between gap-4 border-b px-4 py-3">
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="text-sm font-medium">Default role</span>
							<span className="font-mono text-xs text-muted-foreground">
								MARIMOHUB_DEFAULT_ROLE
							</span>
						</span>
						{config.policy.default_role === null ? (
							<span className="text-xs text-muted-foreground">none — writes are members-only</span>
						) : (
							<span className="font-mono text-xs">{config.policy.default_role}</span>
						)}
					</div>
					<div className="flex items-start justify-between gap-4 px-4 py-3">
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="flex items-center gap-1.5 text-sm font-medium">
								<ShieldCheck className="size-3.5 text-primary" />
								Super admins
							</span>
							<span className="font-mono text-xs text-muted-foreground">
								MARIMOHUB_SUPER_ADMINS
							</span>
						</span>
						{config.policy.super_admins.length === 0 ? (
							<span className="text-xs text-muted-foreground">None configured</span>
						) : (
							<ul className="flex max-w-[60%] flex-col items-end gap-1">
								{config.policy.super_admins.map((entry) => (
									<li key={entry} className="max-w-full truncate font-mono text-xs">
										{entry}
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
				<p className="mt-2 text-xs text-muted-foreground">
					Entries containing “@” match by login email; anything else matches a user id exactly. A
					configured super admin appears on the Users page only after their first sign-in.
				</p>
			</section>

			{groups.length === 0 ? (
				<p className="rounded-xl border border-dashed bg-card/50 px-4 py-6 text-sm text-muted-foreground">
					This deployment reports no configuration.
				</p>
			) : (
				groups.map((group) => (
					<section key={group.name} className="mb-6">
						<div className="mb-2 flex items-center gap-2">
							<h2 className="text-sm font-semibold">{group.name}</h2>
							{group.backend !== null && <Chip>{group.backend}</Chip>}
						</div>
						<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
							{group.settings.map((setting) => (
								<SettingRow key={setting.key} setting={setting} />
							))}
						</div>
					</section>
				))
			)}
		</PageContainer>
	);
}
