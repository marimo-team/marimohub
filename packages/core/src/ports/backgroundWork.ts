import { logOperationalError } from '../operationalLog';
import { noopMetrics } from './metrics';
import type { Metrics } from './metrics';

/**
 * Host-managed, best-effort work. Tasks must be idempotent or CAS-guarded, call
 * the existing owner, and produce nothing a later step of this request reads.
 * Hosts retain tasks until completion and drain them before disposing resources.
 */
export interface BackgroundWork {
	defer(label: string, task: () => Promise<unknown>): void | Promise<void>;
}

export const inlineBackgroundWork: BackgroundWork = {
	async defer(_label, task) {
		await task();
	},
};

const inFlight = new WeakMap<Metrics, Map<string, number>>();

function recordInFlight(metrics: Metrics, label: string, delta: 1 | -1): void {
	let counts = inFlight.get(metrics);
	if (!counts) {
		counts = new Map();
		inFlight.set(metrics, counts);
	}
	const count = (counts.get(label) ?? 0) + delta;
	if (count === 0) counts.delete(label);
	else counts.set(label, count);
	try {
		metrics.gauge('background.in_flight', count, { label });
	} catch {}
}

/** Await in library mode; otherwise hand the guarded task to the host. */
export async function deferOrAwait(
	work: BackgroundWork | undefined,
	label: string,
	task: () => Promise<unknown>,
	metrics: Metrics = noopMetrics,
	failureContext: Record<string, unknown> = {},
): Promise<void> {
	const failed = (error: unknown) => {
		logOperationalError(
			'background_work_failed',
			{ ...failureContext, operation: label, label },
			error,
		);
		try {
			metrics.increment('background.failed', 1, { label });
		} catch {
			// Telemetry must not turn a committed operation into a failure.
		}
	};
	const guarded = async () => {
		const started = performance.now();
		recordInFlight(metrics, label, 1);
		try {
			await task();
		} catch (error) {
			failed(error);
		} finally {
			recordInFlight(metrics, label, -1);
			try {
				metrics.histogram?.('background.duration_ms', performance.now() - started, { label });
			} catch {}
		}
	};
	try {
		await (work ?? inlineBackgroundWork).defer(label, guarded);
	} catch (error) {
		failed(error);
	}
}
