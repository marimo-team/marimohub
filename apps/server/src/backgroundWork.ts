import { context } from '@opentelemetry/api';
import { InFlightWork } from '@marimo-hub/core';
import type { BackgroundWork, Metrics } from '@marimo-hub/core';

interface Limits {
	concurrency: number;
	perLabelConcurrency: number;
	queueSize: number;
	perLabelQueueSize: number;
}

const DEFAULT_LIMITS: Limits = {
	concurrency: 8,
	perLabelConcurrency: 2,
	queueSize: 128,
	perLabelQueueSize: 32,
};

type Task = { label: string; run: () => Promise<unknown> };

/** Bounds deferred work. Overflow runs on the caller's promise and still participates in drain. */
export class DeferredWorkQueue implements BackgroundWork {
	private readonly tasks: Task[] = [];
	private readonly active = new Map<string, number>();
	private readonly pending = new InFlightWork();
	private running = 0;
	private readonly limits: Limits;

	constructor(
		private readonly metrics: Metrics,
		limits: Partial<Limits> = {},
	) {
		this.limits = { ...DEFAULT_LIMITS, ...limits };
		for (const value of Object.values(this.limits)) {
			if (!Number.isInteger(value) || value < 1)
				throw new RangeError('Queue limits must be positive integers');
		}
		this.record();
	}

	defer(label: string, run: () => Promise<unknown>): void | Promise<void> {
		const task = { label, run: context.bind(context.active(), run) };
		if (this.canStart(label)) {
			this.start(task);
			return;
		}
		if (
			this.tasks.length >= this.limits.queueSize ||
			this.queuedCount(label) >= this.limits.perLabelQueueSize
		) {
			try {
				this.metrics.increment('background.inline_fallback', 1, { label });
			} catch {}
			return this.execute(task);
		}
		this.tasks.push(task);
		this.record(label);
	}

	drain(): Promise<void> {
		return this.pending.drain();
	}

	private canStart(label: string): boolean {
		return (
			this.running < this.limits.concurrency &&
			(this.active.get(label) ?? 0) < this.limits.perLabelConcurrency
		);
	}

	private queuedCount(label: string): number {
		return this.tasks.filter((task) => task.label === label).length;
	}

	private changeActive(label: string, delta: 1 | -1): void {
		this.running += delta;
		const count = (this.active.get(label) ?? 0) + delta;
		if (count === 0) this.active.delete(label);
		else this.active.set(label, count);
		this.record(label);
	}

	private execute(task: Task, onSettled?: () => void): Promise<void> {
		// Settlement can start queued work, so it belongs inside the tracked promise.
		return this.pending.track(Promise.resolve().then(task.run).finally(onSettled)).then(() => {});
	}

	private start(task: Task): void {
		this.changeActive(task.label, 1);
		void this.execute(task, () => {
			this.changeActive(task.label, -1);
			this.pump();
		}).catch(() => {});
	}

	private pump(): void {
		while (this.running < this.limits.concurrency) {
			const index = this.tasks.findIndex((task) => this.canStart(task.label));
			if (index === -1) return;
			const [task] = this.tasks.splice(index, 1);
			this.start(task);
		}
	}

	private record(label?: string): void {
		// Telemetry failures must not strand queued work or leak an active slot.
		try {
			this.metrics.gauge('background.queue_depth', this.tasks.length);
			this.metrics.gauge('background.running', this.running);
			if (label !== undefined) {
				this.metrics.gauge('background.queue_depth', this.queuedCount(label), { label });
				this.metrics.gauge('background.running', this.active.get(label) ?? 0, { label });
			}
		} catch {}
	}
}
