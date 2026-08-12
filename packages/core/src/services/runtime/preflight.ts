/**
 * Preflight diagnostics: a vendor-free runner over a list of checks. The concrete
 * checks (storage reachable, OIDC discoverable, WIF key loads, …) are built in
 * `@marimo-hub/config`, which is the only place that knows endpoints/credentials;
 * `core` owns just the types and the runner so the dependency graph stays inward.
 *
 * The runner isolates each check (per-check timeout + try/catch) so one hanging or
 * throwing dependency can neither hang the whole report nor mark it fatal — an
 * exception is "couldn't determine", which is treated as transient. Only a check
 * that *deliberately* returns `fatal: true` (a deterministic, unsafe-to-run
 * misconfiguration) sets `report.fatal`. The entrypoint exits the process on
 * `report.fatal` and otherwise logs and keeps serving, so a backend blip never
 * crashloops a replica.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface CheckResult {
	/** Stable check name, e.g. `storage` or `auth.oidc-discovery`. */
	name: string;
	status: CheckStatus;
	message: string;
	/** What the operator should do about a non-`ok` result. */
	remediation?: string;
	/**
	 * Set only for a deterministic, unsafe-to-run failure that a restart cannot fix
	 * (e.g. a store that demonstrably ignores conditional writes). The boot path
	 * exits on a fatal result; connectivity blips must never set this.
	 */
	fatal?: boolean;
	latencyMs?: number;
}

/** A check's outcome before the runner stamps `name`/`latencyMs`. */
export type CheckOutcome = Omit<CheckResult, 'name' | 'latencyMs'>;

export interface PreflightCheck {
	name: string;
	run: () => Promise<CheckOutcome>;
	/** Override the runner deadline for checks whose own bounded operation is slower. */
	timeoutMs?: number;
}

export interface PreflightReport {
	/** True when no check returned `fail` (warn/skipped still count as ok-to-serve). */
	ok: boolean;
	/** True when any check returned `fatal` — the boot path exits on this. */
	fatal: boolean;
	checks: CheckResult[];
}

export interface RunPreflightOptions {
	/** Per-check timeout before it is reported as a (non-fatal) `fail`. Default 3000ms. */
	timeoutMs?: number;
	/** Wall-clock source; injected so tests need not rely on real timers. */
	now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 3000;

async function runOne(
	check: PreflightCheck,
	defaultTimeoutMs: number,
	now: () => number,
): Promise<CheckResult> {
	const timeoutMs = check.timeoutMs ?? defaultTimeoutMs;
	const start = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<CheckOutcome>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					status: 'fail',
					message: `Timed out after ${timeoutMs}ms (treated as transient)`,
				}),
			timeoutMs,
		);
	});
	try {
		const outcome = await Promise.race([check.run(), timeout]);
		return { name: check.name, latencyMs: now() - start, ...outcome };
	} catch (err) {
		return {
			name: check.name,
			latencyMs: now() - start,
			status: 'fail',
			message: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function runPreflight(
	checks: PreflightCheck[],
	opts: RunPreflightOptions = {},
): Promise<PreflightReport> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = opts.now ?? (() => Date.now());
	const results = await Promise.all(checks.map((c) => runOne(c, timeoutMs, now)));
	return {
		ok: results.every((r) => r.status !== 'fail'),
		fatal: results.some((r) => r.fatal === true),
		checks: results,
	};
}
