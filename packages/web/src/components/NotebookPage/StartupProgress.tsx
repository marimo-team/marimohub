import { Check, LoaderCircle } from 'lucide-react';
import type { SandboxStartupSnapshot } from '@marimo-hub/core/ports/sandbox';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';
import { SANDBOX_STARTUP_PHASES } from '@marimo-hub/core/constants';
import type { SandboxStartupPhase } from '@marimo-hub/core/constants';

const stages: Record<SandboxStartupPhase, { label: string; description: string }> = {
	allocating: {
		label: 'Allocating sandbox',
		description: 'Waiting for compute to become available.',
	},
	workspace: {
		label: 'Preparing workspace',
		description: 'Getting your files and workspace ready.',
	},
	starting: {
		label: 'Starting notebook',
		description: 'Installing dependencies and launching the runtime.',
	},
};

export function StartupProgress({
	progress,
	isApp = false,
}: {
	progress: SandboxStartupSnapshot;
	isApp?: boolean;
}) {
	const now = useNow();
	const current = SANDBOX_STARTUP_PHASES.indexOf(progress.phase);
	return (
		<section
			className="w-full max-w-sm rounded-xl border bg-card p-6 text-left shadow-sm"
			aria-label="Session startup"
		>
			<h2 className="text-base font-semibold text-foreground">
				{isApp ? 'Starting your app' : 'Starting your notebook'}
			</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				Your workspace will open when it’s ready.
			</p>
			<ol className="mt-6 space-y-5" aria-label="Startup progress">
				{SANDBOX_STARTUP_PHASES.map((phase, index) => {
					const active = index === current;
					const complete = index < current && progress.observed.includes(phase);
					return (
						<li
							key={phase}
							className="relative flex gap-3 after:absolute after:top-7 after:-bottom-4 after:left-3 after:border-l after:border-border last:after:hidden"
							aria-current={active ? 'step' : undefined}
						>
							<span
								className={cn(
									'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs',
									active || complete
										? 'bg-primary/10 text-primary'
										: 'border bg-card text-muted-foreground',
								)}
							>
								{complete ? (
									<Check className="size-3.5" aria-label="Complete" />
								) : active ? (
									<LoaderCircle
										className="size-3.5 animate-spin motion-reduce:animate-none"
										aria-hidden="true"
									/>
								) : (
									<span aria-hidden="true">{index + 1}</span>
								)}
							</span>
							<div className="min-w-0 flex-1">
								<div className="flex min-h-6 items-center justify-between gap-3">
									<span
										className={cn(
											'text-sm',
											active ? 'font-medium text-foreground' : 'text-muted-foreground',
										)}
									>
										{isApp && phase === 'starting' ? 'Starting app' : stages[phase].label}
									</span>
									{active && (
										<span
											className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums"
											aria-label="Time in current step"
										>
											{Math.max(0, Math.floor((now - Date.parse(progress.started_at)) / 1000))}s
										</span>
									)}
								</div>
								{active && (
									<output className="mt-1 block text-xs leading-relaxed break-words text-muted-foreground">
										{progress.detail || stages[phase].description}
									</output>
								)}
							</div>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
