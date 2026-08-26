import { AlertTriangle, CheckCircle2, CircleDashed, Play, Terminal, XCircle } from 'lucide-react';
import { Button, Chip, PageContainer, PageHeader } from '@/components/ui';
import { useAppForm } from '@/components/form';
import { useCapabilitiesQuery, useRunSandboxStartupTest } from '@/api/hooks';
import { baseImageOptions, DEFAULT_BASE_IMAGE, imageLabel } from '@/components/Notebook/baseImage';
import {
	computeProfileOptions,
	computeProfileResources,
	DEFAULT_COMPUTE_PROFILE,
} from '@/components/Notebook/computeProfiles';
import type { SandboxStartupReport } from '@/types';

type StartupCommand = SandboxStartupReport['readiness'];
type StartupPhase = SandboxStartupReport['handle'];
type EnvironmentSetupBenchmark = NonNullable<SandboxStartupReport['environment_setup_benchmark']>;

const CONFIGURED_IMAGE_PREFIX = 'configured-image:';
const durationFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function duration(value: number | null): string {
	return value === null ? '—' : `${durationFormatter.format(value)} ms`;
}

function StatusChip({ status }: { status: StartupPhase['status'] }) {
	if (status === 'ok') {
		return (
			<Chip className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
				<CheckCircle2 className="size-3" />
				OK
			</Chip>
		);
	}
	if (status === 'failed') {
		return (
			<Chip className="border-destructive/30 bg-destructive/10 text-destructive">
				<XCircle className="size-3" />
				Failed
			</Chip>
		);
	}
	return (
		<Chip className="border-border bg-muted text-muted-foreground">
			<CircleDashed className="size-3" />
			Skipped
		</Chip>
	);
}

function TimingCell({ label, phase }: { label: string; phase: StartupPhase }) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium text-muted-foreground">{label}</span>
				<StatusChip status={phase.status} />
			</div>
			<span className="font-mono text-lg font-semibold tabular-nums">
				{duration(phase.duration_ms)}
			</span>
		</div>
	);
}

function ErrorDetails({ error }: { error: Record<string, unknown> | undefined }) {
	if (!error) return null;
	return (
		<pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
			{JSON.stringify(error, null, 2)}
		</pre>
	);
}

function CommandResult({ label, result }: { label: string; result: StartupCommand }) {
	return (
		<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
			<div className="flex items-center justify-between gap-3 border-b px-4 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<Terminal className="size-4 shrink-0 text-muted-foreground" />
					<div className="flex min-w-0 flex-col">
						<span className="text-sm font-medium">{label}</span>
						<code className="truncate text-xs text-muted-foreground">{result.command}</code>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span className="font-mono text-xs tabular-nums text-muted-foreground">
						{duration(result.duration_ms)}
					</span>
					<StatusChip status={result.status} />
				</div>
			</div>
			<div className="grid gap-3 p-4 md:grid-cols-2">
				<div className="min-w-0">
					<p className="mb-1 text-xs font-medium text-muted-foreground">stdout</p>
					<pre className="min-h-10 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
						{result.stdout || '—'}
					</pre>
				</div>
				<div className="min-w-0">
					<p className="mb-1 text-xs font-medium text-muted-foreground">stderr</p>
					<pre className="min-h-10 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
						{result.stderr || '—'}
					</pre>
				</div>
				{result.failure_code && (
					<p className="text-xs text-destructive md:col-span-2">
						Failure code: <code>{result.failure_code}</code>
					</p>
				)}
				{result.error && (
					<div className="md:col-span-2">
						<ErrorDetails error={result.error} />
					</div>
				)}
			</div>
		</div>
	);
}

function StartupReport({ report }: { report: SandboxStartupReport }) {
	const startupEntries = Object.entries(report.startup_timings_ms);
	return (
		<section className="mt-8 flex flex-col gap-5" aria-label="Latest startup report">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<h2 className="text-lg font-semibold">Latest report</h2>
					<StatusChip status={report.ok ? 'ok' : 'failed'} />
				</div>
				<span className="font-mono text-xs text-muted-foreground">{report.sandbox_id}</span>
			</div>

			<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
				<div className="grid gap-3 px-4 py-3 text-sm md:grid-cols-2">
					<div className="min-w-0">
						<p className="text-xs font-medium text-muted-foreground">Container image</p>
						<p className="truncate font-medium" title={report.image ?? undefined}>
							{report.image ? imageLabel(report.image) : 'Adapter default'}
						</p>
						{report.image && <p className="truncate font-mono text-xs">{report.image}</p>}
					</div>
					<div>
						<p className="text-xs font-medium text-muted-foreground">Compute profile</p>
						<p className="font-medium">{report.compute_profile ?? 'Platform default'}</p>
						<p className="text-xs text-muted-foreground">
							{computeProfileResources(report.compute_resources)}
						</p>
					</div>
				</div>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
				<div className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5">
					<span className="text-xs font-medium text-muted-foreground">Total</span>
					<span className="font-mono text-lg font-semibold tabular-nums">
						{duration(report.total_ms)}
					</span>
				</div>
				<TimingCell label="Handle" phase={report.handle} />
				<TimingCell label="Readiness" phase={report.readiness} />
				<TimingCell label="Single exec" phase={report.exec} />
				<TimingCell label="Cleanup" phase={report.cleanup} />
			</div>
			{report.handle.error && (
				<div>
					<h3 className="mb-2 text-sm font-semibold text-destructive">
						Sandbox handle creation failed
					</h3>
					<ErrorDetails error={report.handle.error} />
				</div>
			)}

			<div>
				<h3 className="mb-2 text-sm font-semibold">Backend startup breakdown</h3>
				{startupEntries.length === 0 ? (
					<p className="rounded-xl border border-dashed bg-card/50 px-4 py-5 text-sm text-muted-foreground">
						This compute backend did not provide additional startup timings.
					</p>
				) : (
					<div className="overflow-hidden rounded-xl border bg-card shadow-xs">
						{startupEntries.map(([name, value]) => (
							<div
								key={name}
								className="flex items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0"
							>
								<code className="text-xs text-muted-foreground">{name}</code>
								<span className="font-mono text-sm tabular-nums">{duration(value)}</span>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="grid gap-4">
				<CommandResult label="Readiness (first echo)" result={report.readiness} />
				<CommandResult label="Single exec (second echo)" result={report.exec} />
			</div>

			{report.environment_setup_benchmark ? (
				<EnvironmentSetupBenchmarkReport benchmark={report.environment_setup_benchmark} />
			) : null}

			{report.cleanup.error && (
				<div>
					<h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-destructive">
						<AlertTriangle className="size-4" />
						Cleanup failed — the sandbox may still be running
					</h3>
					<ErrorDetails error={report.cleanup.error} />
				</div>
			)}

			<div className="text-xs text-muted-foreground">
				Started{' '}
				<time dateTime={report.started_at}>{new Date(report.started_at).toLocaleString()}</time>
				{' · '}finished{' '}
				<time dateTime={report.finished_at}>{new Date(report.finished_at).toLocaleString()}</time>
				{' · '}counters <code>{JSON.stringify(report.counters)}</code>
			</div>
		</section>
	);
}

function EnvironmentSetupBenchmarkReport({ benchmark }: { benchmark: EnvironmentSetupBenchmark }) {
	return (
		<div>
			<h3 className="mb-1 text-sm font-semibold">Fresh sandbox uv sync benchmark</h3>
			<p className="mb-3 text-xs text-muted-foreground">
				Pinned boto3, botocore, moutils, and obstore against the image&apos;s configured environment
				and cache. CPU counters bracket only the measured sync.
			</p>
			<div className="grid gap-4">
				<CommandResult label="Runtime and CPU limits" result={benchmark.runtime_probe} />
				<CommandResult
					label="Raw wheel download (botocore 1.43.36, 15.3 MB)"
					result={benchmark.artifact_download}
				/>
				<CommandResult
					label="Create uv.lock (not part of sync timing)"
					result={benchmark.prepare}
				/>
				<CommandResult label="uv sync (fresh sandbox)" result={benchmark.install} />
			</div>
		</div>
	);
}

export default function AdminDebugPage() {
	const capabilities = useCapabilitiesQuery();
	const images = capabilities.data?.sandbox_images ?? [];
	const profiles = capabilities.data?.compute_profiles ?? [];
	const run = useRunSandboxStartupTest(capabilities.data?.sandbox_startup_timeout_seconds);
	const imageOptions = baseImageOptions(images).map((option, index) =>
		index === 0
			? images.length === 0
				? { ...option, label: 'Adapter default' }
				: option
			: { ...option, value: `${CONFIGURED_IMAGE_PREFIX}${encodeURIComponent(option.value)}` },
	);
	const configuredProfileOptions = computeProfileOptions(profiles);
	const profileOptions =
		configuredProfileOptions.length > 0
			? configuredProfileOptions
			: [{ value: DEFAULT_COMPUTE_PROFILE, label: 'Platform default' }];
	const form = useAppForm({
		defaultValues: {
			image: DEFAULT_BASE_IMAGE,
			computeProfile: DEFAULT_COMPUTE_PROFILE,
			environmentSetupBenchmark: false,
		},
		onSubmit: async ({ value }) => {
			const image = value.image.startsWith(CONFIGURED_IMAGE_PREFIX)
				? decodeURIComponent(value.image.slice(CONFIGURED_IMAGE_PREFIX.length))
				: undefined;
			try {
				await run.mutateAsync({
					...(image === undefined ? {} : { image }),
					...(value.computeProfile === DEFAULT_COMPUTE_PROFILE
						? {}
						: { compute_profile: value.computeProfile }),
					...(value.environmentSetupBenchmark ? { environment_setup_benchmark: true } : {}),
				});
			} catch {
				return;
			}
		},
	});
	const unavailable = capabilities.isPending || capabilities.isError;

	return (
		<PageContainer>
			<title>Sandbox startup time · marimohub</title>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<PageHeader
					actions={
						<Button type="submit" variant="primary" isDisabled={unavailable || run.isPending}>
							<Play className="size-4" />
							{run.isPending ? 'Running…' : 'Run startup test'}
						</Button>
					}
				>
					<div className="flex min-w-0 flex-col gap-0.5">
						<h1 className="text-2xl font-semibold tracking-tight">Sandbox startup time</h1>
						<p className="text-sm text-muted-foreground">
							Create a fresh sandbox, use the first echo as its readiness probe, then measure one
							steady-state exec. The sandbox is destroyed after every run.
						</p>
					</div>
				</PageHeader>

				{capabilities.isError && (
					<p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
						Unable to load the configured sandbox images and compute profiles.
					</p>
				)}

				<div className="grid gap-5 md:grid-cols-2">
					<form.AppField name="image">
						{(field) => (
							<field.RadioGroupField
								label="Container image"
								options={imageOptions}
								isDisabled={unavailable || run.isPending}
							/>
						)}
					</form.AppField>
					<form.AppField name="computeProfile">
						{(field) => (
							<field.RadioGroupField
								label="Compute profile"
								options={profileOptions}
								isDisabled={unavailable || run.isPending}
							/>
						)}
					</form.AppField>
				</div>

				<div className="mt-5 rounded-lg border bg-card px-4 py-3">
					<form.AppField name="environmentSetupBenchmark">
						{(field) => (
							<field.SwitchField isDisabled={unavailable || run.isPending}>
								{(selected) => (
									<span className="flex flex-col text-left">
										<span className="text-sm font-medium">
											Fresh sandbox uv sync benchmark {selected ? 'enabled' : 'disabled'}
										</span>
										<span className="text-xs text-muted-foreground">
											Adds a raw wheel download, runtime probe, and fixed four-package sync.
										</span>
									</span>
								)}
							</field.SwitchField>
						)}
					</form.AppField>
				</div>

				{run.error && (
					<p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
						{run.error.message}
					</p>
				)}
			</form>

			{run.data && <StartupReport report={run.data} />}
		</PageContainer>
	);
}
