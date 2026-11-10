import { setImmediate } from 'node:timers';
import { isNotModified } from '@marimo-hub/core/ports/bucket';
import type {
	Bucket,
	BucketGetOptions,
	BucketGetResult,
	BucketObjectBody,
} from '@marimo-hub/core/ports/bucket';

type Operation = 'get' | 'get304' | 'head' | 'list' | 'put' | 'delete';

export interface StorageCost {
	requests: number;
	rounds: number;
	estimatedMs: number;
	byOperation: Record<Operation, number>;
	requestsPerRound: number[];
}

/** Equal-latency I/O: release a round together, then drain its promise continuations. */
export class RoundTripBucket implements Bucket {
	private recording = false;
	private pending: (() => void)[] = [];
	private rounds = 0;
	private operations: { kind: Operation; round: number }[] = [];

	constructor(private readonly inner: Bucket) {}

	async measure<T>(action: () => Promise<T>): Promise<{ value: T; cost: StorageCost }> {
		if (this.recording) throw new Error('Storage measurements cannot overlap');
		this.recording = true;
		this.rounds = 0;
		this.operations = [];
		try {
			const value = await action();
			if (this.pending.length > 0)
				throw new Error('Unawaited storage operations at measurement end');
			const byOperation = { get: 0, get304: 0, head: 0, list: 0, put: 0, delete: 0 };
			const requestsPerRound = Array.from({ length: this.rounds }, () => 0);
			for (const op of this.operations) {
				byOperation[op.kind]++;
				requestsPerRound[op.round - 1]++;
			}
			return {
				value,
				cost: {
					requests: this.operations.length,
					rounds: this.rounds,
					estimatedMs: this.rounds * 25,
					byOperation,
					requestsPerRound,
				},
			};
		} finally {
			this.recording = false;
		}
	}

	private async request<T>(kind: Operation, action: () => Promise<T>): Promise<T> {
		if (!this.recording) return action();
		const op = { kind, round: this.rounds + 1 };
		this.operations.push(op);
		await new Promise<void>((resolve) => {
			this.pending.push(resolve);
			if (this.pending.length === 1) {
				// An event-loop turn drains arbitrarily deep microtask chains, unlike
				// a fixed number of `await Promise.resolve()` calls.
				setImmediate(() => {
					const batch = this.pending;
					this.pending = [];
					this.rounds++;
					for (const complete of batch) complete();
				});
			}
		});
		const result = await action();
		if (kind === 'get' && isNotModified(result as BucketGetResult)) op.kind = 'get304';
		return result;
	}

	get(key: string): Promise<BucketObjectBody | null>;
	get(key: string, options?: BucketGetOptions): Promise<BucketGetResult>;
	get(key: string, options?: BucketGetOptions): Promise<BucketGetResult> {
		return this.request('get', () => this.inner.get(key, options));
	}

	head(key: string) {
		return this.request('head', () => this.inner.head(key));
	}

	list(options?: Parameters<Bucket['list']>[0]) {
		return this.request('list', () => this.inner.list(options));
	}

	put(...args: Parameters<Bucket['put']>) {
		return this.request('put', () => this.inner.put(...args));
	}

	delete(key: string | string[]) {
		return this.request('delete', () => this.inner.delete(key));
	}
}
