/**
 * Telemetry port. The domain emits operational signals through this interface so
 * an operator can see what the otherwise-silent bucket-as-database is doing —
 * CAS contention, reaper activity, snapshot growth, live session count — without
 * the core depending on any concrete metrics backend.
 *
 * Three primitives cover the need:
 * - `increment` for counters (rates: CAS conflicts, snapshots pruned, …).
 * - `gauge` for point-in-time values (snapshot count/size, live sessions, …).
 * - `histogram` for distributions (operation latency, payload sizes, …).
 *
 * The default is `noopMetrics`; entrypoints inject a real emitter (e.g. the
 * wide-event canonical-log emitter in `apps/server`, or a Prometheus adapter).
 */
export type MetricTags = Record<string, string | number | boolean>;

export interface Metrics {
	/** Increment a counter by `value` (default 1). */
	increment(name: string, value?: number, tags?: MetricTags): void;
	/** Record a point-in-time value. */
	gauge(name: string, value: number, tags?: MetricTags): void;
	/** Record a value in a distribution, such as operation latency. */
	histogram?(name: string, value: number, tags?: MetricTags): void;
}

/** No-op default — used everywhere a real emitter isn't wired (tests, library mode). */
export const noopMetrics: Metrics = {
	increment() {},
	gauge() {},
	histogram() {},
};
