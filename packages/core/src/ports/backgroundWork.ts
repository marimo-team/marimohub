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
		try {
			await task();
		} catch (error) {
			failed(error);
		}
	};
	try {
		await (work ?? inlineBackgroundWork).defer(label, guarded);
	} catch (error) {
		failed(error);
	}
}
