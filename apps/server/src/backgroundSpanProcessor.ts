import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export class BackgroundSpanProcessor implements SpanProcessor {
	// Weak references retain ancestry for late work without accumulating completed traces.
	private readonly background = new WeakSet<object>();

	constructor(private readonly next: SpanProcessor) {}

	onStart(span: Span, parentContext: Context): void {
		const parent = trace.getSpan(parentContext);
		if (span.name.startsWith('loop.') || (parent && this.background.has(parent))) {
			this.background.add(span);
		}
		this.next.onStart(span, parentContext);
	}

	onEnd(span: ReadableSpan): void {
		const routine =
			span.name.startsWith('Bucket.') ||
			span.name === 'SessionService.getSession' ||
			span.name === 'MaintenanceLock.acquire' ||
			span.name === 'MaintenanceLock.release';
		// Decide after completion so failed operations and recorded exceptions survive.
		if (
			this.background.has(span) &&
			routine &&
			span.status.code !== SpanStatusCode.ERROR &&
			!span.events.some((event) => event.name === 'exception')
		) {
			return;
		}
		this.next.onEnd(span);
	}

	forceFlush(): Promise<void> {
		return this.next.forceFlush();
	}

	shutdown(): Promise<void> {
		return this.next.shutdown();
	}
}
