import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { ApiDeps } from '@marimo-hub/api';
import { withAbortSignal, withDeadline } from '@marimo-hub/core';
import type { MaintenanceLock, Metrics } from '@marimo-hub/core';
import { logEvent } from './log';

type LoopHealthReport = ReturnType<NonNullable<ApiDeps['loopHealth']>>;
type LoopHealth = LoopHealthReport['loops'][string];
type Outcome = 'success' | 'failed' | 'stalled' | 'skipped';

interface LoopState {
	failure_event: string;
	interval_ms: number;
	deadline_ms: number;
	registered_at: number;
	/** Registration, the last completed attempt, or the last recovery from a stall. */
	progress_at: number;
	last_started_at: number | null;
	last_completed_at: number | null;
	last_success_at: number | null;
	last_duration_ms: number | null;
	consecutive_failures: number;
	timeouts: number;
	/** Held until the attempt's work settles, even after its deadline. */
	running: boolean;
	stalled: boolean;
	stopped: boolean;
}

interface LoopContext {
	/** Unique per attempt; set only for leased loops. */
	holder: string | undefined;
	signal: AbortSignal;
	/**
	 * Run `work`, skipping it (and every later step) once the attempt is aborted.
	 * The step is not raced against the signal: work that ignores the signal holds
	 * the attempt, and so the in-flight guard, until it settles, so a hung sweep
	 * cannot overlap its successor.
	 */
	step<T>(work: () => Promise<T>): Promise<T>;
}

interface LoopOptions<T> {
	name: string;
	intervalMs: number;
	deadlineMs?: number;
	failureEvent?: string;
	abortOnStop?: boolean;
	overlapEvent?: string;
	lock?: MaintenanceLock;
	notLeaderEvent?: string;
	shouldRun?: () => Promise<boolean>;
	run(context: LoopContext): Promise<T>;
	/** Called after the heartbeat is recorded; skipped and timed-out work cannot report success. */
	onSuccess?(result: T): void;
}

export interface LoopHandle extends Disposable, AsyncDisposable {
	stop(): void;
	/** Resolves once the current attempt has an outcome; abandoned work may still be settling. */
	drain(): Promise<void>;
}

class LoopDeadlineError extends Error {
	override name = 'LoopDeadlineError';
}

function logFailure(event: string, error: unknown, fields: Record<string, unknown> = {}) {
	logEvent({
		level: 'error',
		event,
		error: error instanceof Error ? error.message : String(error),
		name: error instanceof Error ? error.name : undefined,
		...fields,
	});
}

export class BackgroundLoops {
	private readonly states = new Map<string, LoopState>();

	constructor(private readonly metrics?: Metrics) {}

	start<T>(options: LoopOptions<T>): LoopHandle {
		const { name } = options;
		// Provisioning and snapshotting can take minutes even on a five-second cadence.
		const deadlineMs = options.deadlineMs ?? Math.max(3 * options.intervalMs, 10 * 60_000);
		const now = Date.now();
		const state: LoopState = {
			failure_event: options.failureEvent ?? `${name}_failed`,
			interval_ms: options.intervalMs,
			deadline_ms: deadlineMs,
			registered_at: now,
			progress_at: now,
			last_started_at: null,
			last_completed_at: null,
			last_success_at: null,
			last_duration_ms: null,
			consecutive_failures: 0,
			timeouts: 0,
			running: false,
			stalled: false,
			stopped: false,
		};
		this.states.set(name, state);
		const stopping = new AbortController();

		const work = async (
			signal: AbortSignal,
			started: number,
			lease: { lock: MaintenanceLock; holder: string } | undefined,
		): Promise<{ value: T } | undefined> => {
			const context: LoopContext = {
				holder: lease?.holder,
				signal,
				async step(fn) {
					signal.throwIfAborted();
					const result = await fn();
					signal.throwIfAborted();
					return result;
				},
			};
			if (options.shouldRun && !(await context.step(options.shouldRun))) return undefined;
			if (
				lease &&
				!(await context.step(() =>
					lease.lock.acquire(lease.holder, Math.max(1, deadlineMs - (Date.now() - started))),
				))
			) {
				if (options.notLeaderEvent)
					logEvent({ level: 'debug', event: options.notLeaderEvent, holder: lease.holder });
				return undefined;
			}
			try {
				return { value: await options.run(context) };
			} finally {
				// After a deadline, leave the lease to expire instead of releasing it late.
				if (lease && !signal.aborted)
					await withAbortSignal(lease.lock.release(lease.holder, signal), signal).catch(
						(error: unknown) => {
							if (!signal.aborted)
								logFailure(`${name}_release_failed`, error, { holder: lease.holder });
						},
					);
			}
		};

		const attempt = () =>
			trace.getTracer('@marimo-hub/server').startActiveSpan(`loop.${name}`, async (span) => {
				const started = Date.now();
				state.running = true;
				state.last_started_at = started;
				const lease = options.lock
					? { lock: options.lock, holder: `${os.hostname()}:${process.pid}:${randomUUID()}` }
					: undefined;
				let pending: Promise<unknown> | undefined;
				let outcome: Outcome;
				let result: { value: T } | undefined;
				let error: unknown;
				try {
					result = await withDeadline((signal) => (pending = work(signal, started, lease)), {
						timeoutMs: deadlineMs,
						signal: options.abortOnStop ? stopping.signal : undefined,
						timeoutError: () =>
							new LoopDeadlineError(`${name} exceeded its ${deadlineMs} ms deadline`),
					});
					outcome = result ? 'success' : 'skipped';
				} catch (err) {
					error = err;
					outcome = err instanceof LoopDeadlineError ? 'stalled' : 'failed';
				}
				const cancelled = outcome === 'failed' && stopping.signal.aborted;
				try {
					if (cancelled) outcome = 'skipped';
					else this.record(name, state, outcome, started, error, lease?.holder);
					if (outcome === 'stalled' || cancelled) {
						const settle = () => this.settle(name, state, lease?.holder);
						void (pending ?? Promise.resolve()).then(settle, settle);
					} else state.running = false;
					if (outcome === 'success' && result) {
						try {
							options.onSuccess?.(result.value);
						} catch (err) {
							logFailure(`${name}_report_failed`, err, { holder: lease?.holder });
						}
					}
				} finally {
					span.setAttributes({
						'marimohub.loop.name': name,
						'marimohub.loop.outcome': outcome,
					});
					if (outcome === 'failed' || outcome === 'stalled') {
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: error instanceof Error ? error.message : String(error),
						});
					}
					span.end();
				}
			});

		let current: Promise<void> = Promise.resolve();
		const tick = () => {
			if (state.stopped) return;
			if (state.running) {
				if (options.overlapEvent) logEvent({ level: 'debug', event: options.overlapEvent });
				return;
			}
			current = attempt();
		};
		tick();
		const interval = setInterval(tick, options.intervalMs);
		const stop = () => {
			state.stopped = true;
			clearInterval(interval);
			if (options.abortOnStop) stopping.abort(new Error(`${name} stopped`));
		};
		const drain = () => current;
		return {
			stop,
			drain,
			[Symbol.dispose]: stop,
			[Symbol.asyncDispose]: async () => {
				stop();
				await drain();
			},
		};
	}

	private record(
		name: string,
		state: LoopState,
		outcome: Outcome,
		started: number,
		error: unknown,
		holder: string | undefined,
	) {
		const now = Date.now();
		state.last_completed_at = now;
		state.last_duration_ms = now - started;
		state.progress_at = now;
		if (outcome === 'success' || outcome === 'skipped') {
			state.last_success_at = now;
			state.consecutive_failures = 0;
		} else {
			state.consecutive_failures++;
			if (outcome === 'stalled') {
				state.timeouts++;
				state.stalled = true;
				this.metrics?.increment('loop.timeouts', 1, { loop: name });
			}
			logFailure(outcome === 'stalled' ? `${name}_stalled` : state.failure_event, error, {
				holder,
				deadline_ms: state.deadline_ms,
				duration_ms: state.last_duration_ms,
			});
		}
		this.publish(name, state);
	}

	private settle(name: string, state: LoopState, holder: string | undefined) {
		state.running = false;
		if (!state.stalled) return;
		state.stalled = false;
		state.progress_at = Date.now();
		logEvent({ level: 'debug', event: `${name}_recovered`, holder });
		this.publish(name, state);
	}

	private publish(name: string, state: LoopState) {
		if (!this.metrics) return;
		const tags = { loop: name };
		const since = (Date.now() - (state.last_success_at ?? state.registered_at)) / 1000;
		this.metrics.gauge('loop.seconds_since_success', since, tags);
		this.metrics.gauge('loop.consecutive_failures', state.consecutive_failures, tags);
		if (state.last_duration_ms !== null)
			this.metrics.gauge('loop.last_duration_ms', state.last_duration_ms, tags);
		this.metrics.gauge('loop.stalled', Number(state.stalled), tags);
	}

	health(): LoopHealthReport {
		const now = Date.now();
		const loops: Record<string, LoopHealth> = {};
		for (const [name, state] of this.states) {
			loops[name] = {
				status: state.stopped
					? 'stopping'
					: state.stalled || now - state.progress_at >= state.deadline_ms + state.interval_ms
						? 'stalled'
						: state.consecutive_failures > 0
							? 'failing'
							: 'ok',
				last_started_at: state.last_started_at,
				last_completed_at: state.last_completed_at,
				last_success_at: state.last_success_at,
				last_duration_ms: state.last_duration_ms,
				seconds_since_success:
					state.last_success_at === null ? null : (now - state.last_success_at) / 1000,
				consecutive_failures: state.consecutive_failures,
				timeouts: state.timeouts,
				interval_ms: state.interval_ms,
				deadline_ms: state.deadline_ms,
			};
		}
		const statuses = new Set(Object.values(loops).map((loop) => loop.status));
		return {
			status: statuses.has('stalled') ? 'stalled' : statuses.has('failing') ? 'degraded' : 'ok',
			loops,
		};
	}

	collect(): Record<string, number | null> {
		const fields: Record<string, number | null> = {};
		for (const [name, loop] of Object.entries(this.health().loops)) {
			fields[`gauge.loop.${name}.seconds_since_success`] = loop.seconds_since_success;
			fields[`gauge.loop.${name}.last_duration_ms`] = loop.last_duration_ms;
			fields[`gauge.loop.${name}.consecutive_failures`] = loop.consecutive_failures;
			fields[`gauge.loop.${name}.stalled`] = Number(loop.status === 'stalled');
			fields[`counter.loop.${name}.timeouts`] = loop.timeouts;
		}
		return fields;
	}
}
