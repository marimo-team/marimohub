import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { MaintenanceLock } from '@marimo-hub/core';
import { logEvent } from './log';

interface LoopState {
	interval_ms: number;
	deadline_ms: number;
	registered_at: number;
	last_started_at: number | null;
	last_completed_at: number | null;
	last_success_at: number | null;
	last_duration_ms: number | null;
	running: boolean;
	stopped: boolean;
	timeouts: number;
}

interface LoopContext {
	holder: string;
	signal: AbortSignal;
	step<T>(work: () => Promise<T>): Promise<T>;
}

interface LoopOptions {
	name: string;
	intervalMs: number;
	deadlineMs?: number;
	failureEvent?: string;
	abortOnStop?: boolean;
	overlapEvent?: string;
	lock?: MaintenanceLock;
	notLeaderEvent?: string;
	shouldRun?: () => Promise<boolean>;
	run(context: LoopContext): Promise<void>;
}

export class BackgroundLoops {
	private readonly states = new Map<string, LoopState>();

	start(options: LoopOptions): { stop(): void; drain(): Promise<void> } {
		// Provisioning and snapshotting can take minutes even on a five-second cadence.
		const deadlineMs = options.deadlineMs ?? Math.max(3 * options.intervalMs, 10 * 60_000);
		const state: LoopState = {
			interval_ms: options.intervalMs,
			deadline_ms: deadlineMs,
			registered_at: Date.now(),
			last_started_at: null,
			last_completed_at: null,
			last_success_at: null,
			last_duration_ms: null,
			running: false,
			stopped: false,
			timeouts: 0,
		};
		this.states.set(options.name, state);
		let current = Promise.resolve();
		let controller: AbortController | undefined;
		const run = () => {
			if (state.stopped) return;
			if (state.running) {
				if (options.overlapEvent) logEvent({ level: 'debug', event: options.overlapEvent });
				return;
			}
			const started = Date.now();
			state.running = true;
			state.last_started_at = started;
			const attempt = new AbortController();
			controller = attempt;
			const holder = `${os.hostname()}:${process.pid}:${randomUUID()}`;
			const context: LoopContext = {
				holder,
				signal: attempt.signal,
				async step(work) {
					attempt.signal.throwIfAborted();
					const result = await work();
					attempt.signal.throwIfAborted();
					return result;
				},
			};
			current = new Promise<void>((resolve) => {
				let settled = false;
				const finish = (outcome: 'success' | 'failed' | 'stalled', error?: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					state.running = false;
					state.last_completed_at = Date.now();
					state.last_duration_ms = Date.now() - started;
					if (outcome === 'success') state.last_success_at = Date.now();
					else {
						if (outcome === 'stalled') {
							state.timeouts++;
							attempt.abort(new Error(`${options.name} exceeded its deadline`));
						}
						logEvent({
							level: 'error',
							event:
								outcome === 'stalled'
									? `${options.name}_stalled`
									: (options.failureEvent ?? `${options.name}_failed`),
							holder,
							deadline_ms: deadlineMs,
							duration_ms: state.last_duration_ms,
							error:
								error instanceof Error
									? error.message
									: typeof error === 'string'
										? error
										: undefined,
							name: error instanceof Error ? error.name : undefined,
						});
					}
					resolve();
				};
				const timer = setTimeout(() => finish('stalled'), deadlineMs);
				timer.unref();
				const work = async () => {
					if (options.shouldRun && !(await context.step(options.shouldRun))) return;
					if (
						options.lock &&
						!(await context.step(() => options.lock!.acquire(holder, deadlineMs)))
					) {
						if (options.notLeaderEvent)
							logEvent({ level: 'debug', event: options.notLeaderEvent, holder });
						return;
					}
					try {
						await context.step(() => options.run(context));
					} finally {
						// After a deadline, leave the lease to expire instead of releasing it late.
						if (options.lock && !attempt.signal.aborted)
							await options.lock.release(holder, attempt.signal);
					}
				};
				void work().then(
					() => finish('success'),
					(error: unknown) => finish('failed', error),
				);
			});
		};
		run();
		const interval = setInterval(run, options.intervalMs);
		return {
			stop: () => {
				state.stopped = true;
				clearInterval(interval);
				if (options.abortOnStop) controller?.abort();
			},
			drain: () => current,
		};
	}

	health() {
		const now = Date.now();
		const loops = Object.fromEntries(
			[...this.states].map(([name, state]) => [
				name,
				{
					...state,
					seconds_since_success:
						state.last_success_at === null ? null : (now - state.last_success_at) / 1000,
					stale:
						state.stopped ||
						now - (state.last_success_at ?? state.registered_at) >=
							state.deadline_ms + state.interval_ms,
				},
			]),
		);
		return { ok: Object.values(loops).every((loop) => !loop.stale), loops };
	}

	collect(): Record<string, number | null> {
		const fields: Record<string, number | null> = {};
		for (const [name, state] of Object.entries(this.health().loops)) {
			for (const field of [
				'last_started_at',
				'last_completed_at',
				'last_success_at',
				'last_duration_ms',
				'seconds_since_success',
			] as const) {
				fields[`gauge.loop.${name}.${field}`] = state[field];
			}
			fields[`gauge.loop.${name}.stale`] = Number(state.stale);
			fields[`counter.loop.${name}.timeouts`] = state.timeouts;
		}
		return fields;
	}
}
