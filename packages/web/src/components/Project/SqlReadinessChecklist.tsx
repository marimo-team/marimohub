import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import { schemaFieldId } from '@/components/form/schema-form';
import type { QueryReadinessCheck } from '@/types';

function revealField(path: string) {
	const target = document.getElementById(schemaFieldId(path));
	if (!target) return;
	let disclosure = target.closest('details');
	while (disclosure) {
		disclosure.open = true;
		disclosure = disclosure.parentElement?.closest('details') ?? null;
	}
	requestAnimationFrame(() => {
		target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
		target.querySelector<HTMLElement>('input, textarea, button, select, summary')?.focus();
	});
}

export function SqlReadinessChecklist({
	checks,
	isPending,
	isError,
}: {
	checks: QueryReadinessCheck[] | undefined;
	isPending: boolean;
	isError: boolean;
}) {
	if (isPending || isError || checks === undefined) {
		return (
			<section className="rounded-lg border bg-muted/20 p-3" aria-labelledby="sql-readiness-title">
				<h4 id="sql-readiness-title" className="text-xs font-semibold">
					Run SQL readiness
				</h4>
				<p className="mt-0.5 text-xs text-muted-foreground">
					{isError ? 'Could not check SQL readiness.' : 'Checking this configuration…'}
				</p>
			</section>
		);
	}
	const readyCount = checks.filter((check) => check.ready).length;
	const ready = readyCount === checks.length;

	return (
		<section aria-labelledby="sql-readiness-title">
			<details className="group overflow-hidden rounded-lg border bg-muted/20">
				<summary className="flex cursor-pointer list-none items-start gap-2 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
					{ready ? (
						<Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
					) : (
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
					)}
					<div>
						<h4 id="sql-readiness-title" className="text-xs font-semibold">
							Run SQL readiness
						</h4>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{ready
								? 'This configuration is SQL-ready. Deployment-level Run SQL settings still apply.'
								: `${readyCount} of ${checks.length} configuration checks pass. Expand to review and edit failing checks.`}
						</p>
					</div>
					<ChevronDown
						className="ml-auto mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
						aria-hidden
					/>
				</summary>
				<ul className="grid gap-1.5 border-t px-3 py-2 sm:grid-cols-2">
					{checks.map((check) => (
						<li key={check.id}>
							<a
								href={`#${schemaFieldId(check.field)}`}
								onClick={(event) => {
									event.preventDefault();
									revealField(check.field);
								}}
								className="flex items-start gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{check.ready ? (
									<Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
								) : (
									<CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
								)}
								<span className={check.ready ? 'text-muted-foreground' : 'text-foreground'}>
									{check.label}
								</span>
							</a>
						</li>
					))}
				</ul>
			</details>
		</section>
	);
}
