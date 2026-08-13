import type {
	Metrics,
	ObjectBody,
	ObjectBrowseContext,
	ObjectPreview,
	ObjectStoreProvider,
} from '@marimo-hub/core';
import { noopMetrics, ObjectBrowseError } from '@marimo-hub/core';
import type { ObjectBrowserLimits } from './limits';

export class ObjectBrowserObserver {
	private readonly metrics: Metrics;

	constructor(
		private readonly provider: ObjectStoreProvider,
		private readonly mode: 'metadata' | 'full',
		metrics?: Metrics,
	) {
		this.metrics = metrics ?? noopMetrics;
	}

	async observe<T>(
		operation: string,
		context: ObjectBrowseContext,
		run: () => Promise<T>,
	): Promise<T> {
		const tags = { operation, mode: this.mode };
		const startedAt = performance.now();
		this.metrics.increment(this.name('operations'), 1, tags);
		try {
			return await run();
		} catch (error) {
			this.metrics.increment(this.name('failures'), 1, {
				...tags,
				code: error instanceof ObjectBrowseError ? error.code : 'unavailable',
			});
			if (error instanceof ObjectBrowseError && error.code === 'aborted') {
				this.metrics.increment(
					this.name(context.signal?.aborted ? 'cancellations' : 'timeouts'),
					1,
					tags,
				);
			}
			throw error;
		} finally {
			const latency = performance.now() - startedAt;
			if (this.metrics.histogram) {
				this.metrics.histogram(this.name('latency_ms'), latency, tags);
			} else {
				this.metrics.gauge(this.name('latency_ms'), latency, tags);
			}
		}
	}

	keysScanned(count: number): void {
		this.metrics.increment(this.name('keys_scanned'), count, {
			operation: 'search_objects',
			mode: this.mode,
		});
	}

	previewRead(result: ObjectPreview, limits: ObjectBrowserLimits): void {
		const probeBytes = Math.min(result.total_bytes ?? 0, limits.previewMaxBytes);
		const bytes =
			!('bytes_read' in result) || result.bytes_read === undefined
				? probeBytes
				: result.kind === 'tabular' && result.format === 'parquet'
					? result.bytes_read + probeBytes
					: result.bytes_read;
		this.metrics.increment(this.name('bytes_read'), bytes, {
			operation: 'preview_object',
			mode: this.mode,
		});
	}

	observeBody(object: ObjectBody, probeBytes: number): ObjectBody {
		const reader = object.body.getReader();
		let bytesRead = probeBytes;
		let finished = false;
		const tags = { operation: 'open_object', mode: this.mode };
		const metrics = this.metrics;
		const name = this.name.bind(this);
		const finish = () => {
			if (finished) return;
			finished = true;
			metrics.increment(name('bytes_read'), bytesRead, tags);
		};
		return {
			...object,
			body: new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const next = await reader.read();
						if (next.done) {
							finish();
							controller.close();
						} else {
							bytesRead += next.value.byteLength;
							controller.enqueue(next.value);
						}
					} catch (error) {
						finish();
						metrics.increment(name('failures'), 1, {
							...tags,
							code: error instanceof ObjectBrowseError ? error.code : 'unavailable',
						});
						controller.error(error);
					}
				},
				async cancel(reason) {
					metrics.increment(
						name(
							(reason as { name?: unknown } | null)?.name === 'TimeoutError'
								? 'timeouts'
								: 'cancellations',
						),
						1,
						tags,
					);
					try {
						await reader.cancel(reason);
					} finally {
						finish();
					}
				},
			}),
			close() {
				finish();
				void reader.cancel().catch(() => {});
				object.close();
			},
		};
	}

	private name(suffix: string): string {
		return `object_browser.${this.provider}.${suffix}`;
	}
}
