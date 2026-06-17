import { Semaphore } from './concurrency';
import { BUCKET_WRITE_CONCURRENCY } from './constants';
import type { Metrics } from './ports/metrics';

/**
 * Saga orchestrator for dependent operations that span more than one resource
 * (storage, compute, catalog). Each step runs sequentially; if a step throws,
 * previously completed steps are compensated in reverse order and the original
 * error is rethrown. The step that failed is NOT compensated — its own cleanup
 * (if any) belongs inside its `do`.
 *
 * Every step auto-tags the observer with `${name}_succeeded` or `${name}_failed`;
 * compensations tag `${name}_compensated` or `${name}_compensation_failed`. The
 * observer is deliberately tiny and logging-agnostic so this stays vendor-free
 * and usable from both `core` services (via `metricsObserver`) and the API layer.
 *
 * @example
 * await saga(metricsObserver(metrics, 'saga.notebook_create'))
 *   .step('write_files', {
 *     do: () => writeBlobs(),
 *     compensate: () => bucket.delete(keys),
 *   })
 *   .step('catalog', () => catalog.mutateSnapshot(...))
 *   .run();
 */
export interface SagaObserver {
	/** Tag a step outcome, e.g. `('db_create_succeeded', true)`. */
	tag(field: string, value: unknown): void;
	/** Report a compensation failure (never masks the original error). */
	error(message: string, ctx: Record<string, unknown>): void;
}

export interface SagaStep {
	do: () => unknown;
	compensate?: () => unknown;
}

type StepArg = SagaStep | SagaStep['do'];

class Saga {
	private readonly steps: { name: string; step: SagaStep }[] = [];

	constructor(private readonly observer: SagaObserver) {}

	step(name: string, step: StepArg): this {
		const normalized: SagaStep = typeof step === 'function' ? { do: step } : step;
		this.steps.push({ name, step: normalized });
		return this;
	}

	async run(): Promise<void> {
		const completed: { name: string; compensate: () => unknown }[] = [];

		for (const { name, step } of this.steps) {
			const startedAt = Date.now();
			try {
				await step.do();
				this.observer.tag(`${name}_succeeded`, true);
				this.observer.tag(`${name}_ms`, Date.now() - startedAt);
				if (step.compensate) {
					completed.push({ name, compensate: step.compensate });
				}
			} catch (error) {
				this.observer.tag(`${name}_failed`, true);
				this.observer.tag(`${name}_ms`, Date.now() - startedAt);
				await this.compensate(completed, error);
				throw error;
			}
		}
	}

	private async compensate(
		completed: { name: string; compensate: () => unknown }[],
		originalError: unknown,
	): Promise<void> {
		for (let i = completed.length - 1; i >= 0; i--) {
			const entry = completed[i];
			if (!entry) {
				continue;
			}
			const { name, compensate } = entry;
			try {
				await compensate();
				this.observer.tag(`${name}_compensated`, true);
			} catch (compensationError) {
				this.observer.tag(`${name}_compensation_failed`, true);
				this.observer.error('saga compensation failed', {
					step: name,
					compensation_error: compensationError,
					original_error: originalError,
				});
			}
		}
	}
}

export function saga(observer: SagaObserver): Saga {
	return new Saga(observer);
}

/**
 * A saga step that runs a batch of blob `writes` with bounded parallelism and,
 * on any failure, runs `cleanup` before rethrowing.
 *
 * `allSettled` semantics are deliberate: it waits for EVERY write to settle
 * before cleaning up, so a straggler put can't land *after* the compensating
 * delete and leak an orphan — the trap with `Promise.all`, which rejects on the
 * first failure while the rest are still in flight (and drops their rejections
 * as unhandled). The concurrency bound keeps an unbounded batch (a git-sync push
 * of many files) from firing thousands of simultaneous puts.
 *
 * `cleanup` is also the step's `compensate`, so a partial batch is undone whether
 * this step fails (self-clean — the saga never compensates the failing step) or a
 * LATER step does. On multiple write failures the first (in input order) is
 * rethrown. Cleanup errors are swallowed so they never mask the write failure.
 *
 * `writes` are deferred thunks (`() => bucket.put(...)`), NOT live promises, so
 * the semaphore actually gates when each put fires.
 */
export function compensableWrite(
	writes: (() => Promise<unknown>)[],
	cleanup: () => Promise<unknown>,
	concurrency: number = BUCKET_WRITE_CONCURRENCY,
): SagaStep {
	return {
		do: async () => {
			const sem = new Semaphore(concurrency);
			const results = await Promise.allSettled(writes.map((w) => sem.run(w)));
			const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
			if (failed) {
				await cleanup().catch(() => {});
				throw failed.reason;
			}
		},
		compensate: cleanup,
	};
}

/**
 * Observer backed by the `Metrics` port — the only observability primitive
 * available inside `core`. Step outcomes become counters under `prefix`
 * (e.g. `saga.notebook_create.write_files_succeeded`); compensation failures
 * also bump `${prefix}.compensation_failed`. Error detail is dropped (core has
 * no logger), which is acceptable for the low-stakes blob-cleanup flows.
 */
export function metricsObserver(metrics: Metrics, prefix: string): SagaObserver {
	return {
		tag(field, value) {
			// Numbers (e.g. `_ms` durations) are gauges; outcome flags are counters.
			if (typeof value === 'number') {
				metrics.gauge(`${prefix}.${field}`, value);
			} else {
				metrics.increment(`${prefix}.${field}`);
			}
		},
		error() {
			metrics.increment(`${prefix}.compensation_failed`);
		},
	};
}
