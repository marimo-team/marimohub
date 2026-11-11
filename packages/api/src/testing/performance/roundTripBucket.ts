import { setImmediate } from 'node:timers';
import { isNotModified } from '@marimo-hub/core/ports/bucket';
import type {
	Bucket,
	BucketGetOptions,
	BucketGetResult,
	BucketObjectBody,
} from '@marimo-hub/core/ports/bucket';

type Operation =
	| 'get'
	| 'get304'
	| 'head'
	| 'list'
	| 'put'
	| 'delete'
	| 'putStream'
	| 'multipartCreate'
	| 'multipartPutPart'
	| 'multipartComplete'
	| 'multipartAbort';

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
	private active = new Set<Promise<unknown>>();
	private rounds = 0;
	private operations: { kind: Operation; round: number }[] = [];

	readonly putStream?: Bucket['putStream'];
	readonly multipart?: Bucket['multipart'];

	constructor(private readonly inner: Bucket) {
		if (inner.putStream) {
			const putStream = inner.putStream.bind(inner);
			this.putStream = (...args) => this.request('putStream', () => putStream(...args));
		}
		if (inner.multipart) {
			const multipart = inner.multipart;
			this.multipart = {
				isolatedSessions: multipart.isolatedSessions,
				create: (...args) => this.request('multipartCreate', () => multipart.create(...args)),
				putPart: (...args) => this.request('multipartPutPart', () => multipart.putPart(...args)),
				complete: (...args) => this.request('multipartComplete', () => multipart.complete(...args)),
				abort: (...args) => this.request('multipartAbort', () => multipart.abort(...args)),
			};
		}
	}

	async measure<T>(action: () => Promise<T>): Promise<{ value: T; cost: StorageCost }> {
		if (this.recording) throw new Error('Storage measurements cannot overlap');
		this.recording = true;
		this.rounds = 0;
		this.operations = [];
		try {
			const value = await action();
			if (this.active.size > 0) throw new Error('Unawaited storage operations at measurement end');
			const byOperation: StorageCost['byOperation'] = {
				get: 0,
				get304: 0,
				head: 0,
				list: 0,
				put: 0,
				delete: 0,
				putStream: 0,
				multipartCreate: 0,
				multipartPutPart: 0,
				multipartComplete: 0,
				multipartAbort: 0,
			};
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
		} catch (error) {
			// A rejected branch can leave siblings and their continuations in flight.
			do {
				await Promise.allSettled([...this.active]);
				await new Promise<void>((resolve) => setImmediate(resolve));
			} while (this.active.size > 0);
			throw error;
		} finally {
			this.recording = false;
		}
	}

	private request<T>(kind: Operation, action: () => Promise<T>): Promise<T> {
		if (!this.recording) return action();
		const task = this.recordRequest(kind, action);
		this.active.add(task);
		void task.then(
			() => this.active.delete(task),
			() => this.active.delete(task),
		);
		return task;
	}

	private async recordRequest<T>(kind: Operation, action: () => Promise<T>): Promise<T> {
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
