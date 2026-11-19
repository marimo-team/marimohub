import type { Metrics, MetricTags } from '../ports/metrics';

export class CaptureTelemetry {
	private readonly started = performance.now();

	constructor(
		private readonly metrics?: Metrics,
		private readonly acknowledgedAt?: string,
	) {}

	milestone(name: 'source_visible' | 'durable'): void {
		this.histogram(`${name}_ms`, performance.now() - this.started);
		if (this.acknowledgedAt)
			this.histogram(`${name}_lag_ms`, Date.now() - Date.parse(this.acknowledgedAt));
		if (name === 'durable') {
			try {
				this.metrics?.increment('sessions.capture.durable');
			} catch {}
		}
	}

	complete(tags: MetricTags): void {
		this.histogram('total_ms', performance.now() - this.started, tags);
	}

	bytes(name: 'artifact_bytes' | 'uploaded_bytes', content: string, artifact: string): void {
		if (this.metrics?.histogram)
			this.histogram(name, new TextEncoder().encode(content).byteLength, { artifact });
	}

	histogram(name: string, value: number, tags?: MetricTags): void {
		try {
			this.metrics?.histogram?.(`sessions.capture.${name}`, Math.max(0, value), tags);
		} catch {}
	}

	async time<T>(phase: string, operation: () => Promise<T>): Promise<T> {
		const start = performance.now();
		let outcome = 'failed';
		try {
			const result = await operation();
			outcome = 'success';
			return result;
		} finally {
			this.histogram('phase_ms', performance.now() - start, { phase, outcome });
		}
	}
}
