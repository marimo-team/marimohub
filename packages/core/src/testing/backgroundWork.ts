import type { BackgroundWork } from '../ports/backgroundWork';

/** A host double that holds deferred tasks until the test runs them. */
export function queuedBackgroundWork(): {
	work: BackgroundWork;
	/** Every label deferred so far, in order, including tasks already run. */
	labels: string[];
	pending(): number;
	/** Runs queued tasks in order, including tasks they defer, until none remain. */
	runAll(): Promise<void>;
} {
	const queue: (() => Promise<unknown>)[] = [];
	const labels: string[] = [];
	return {
		work: {
			defer(label, task) {
				labels.push(label);
				queue.push(task);
			},
		},
		labels,
		pending: () => queue.length,
		async runAll() {
			while (queue.length > 0) await queue.shift()!();
		},
	};
}
