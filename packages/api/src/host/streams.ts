import { sleep } from '@marimo-hub/core';
import type { HostEvent } from '@marimo-hub/core/host-bridge';
import { acceptsEvent, errorResponse, sse } from './protocol';

export type SendEvent = (event: HostEvent) => Promise<void>;

export function eventStream(
	request: Request,
	work: (send: SendEvent, signal: AbortSignal) => Promise<void>,
): Response {
	const cancelled = new AbortController();
	const signal = AbortSignal.any([request.signal, cancelled.signal]);
	const encoder = new TextEncoder();
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const writer = stream.writable.getWriter();
	const write = async (value: string) => {
		signal.throwIfAborted();
		await writer.write(encoder.encode(value));
	};
	const aborted = () => {
		void writer.abort(signal.reason).catch(() => {});
	};
	signal.addEventListener('abort', aborted, { once: true });
	const ping = async () => {
		while (!signal.aborted) {
			await sleep(15_000, signal);
			await write(': ping\n\n');
		}
	};
	void ping().catch(() => {});
	void work(async (event) => write(sse(event)), signal)
		.catch(async (error: unknown) => {
			if (!signal.aborted) {
				await write(
					sse({
						event: 'effect/httpapi/stream/failure',
						data: (await errorResponse(error).json()) as Record<string, unknown>,
					}),
				).catch(() => {});
			}
		})
		.finally(() => {
			signal.removeEventListener('abort', aborted);
			cancelled.abort();
			void writer.close().catch(() => {});
		});
	const reader = stream.readable.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) controller.close();
					else controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
				}
			},
			async cancel(reason) {
				cancelled.abort(reason);
				await reader.cancel(reason).catch(() => {});
			},
		}),
		{
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-store',
				'X-Accel-Buffering': 'no',
			},
		},
	);
}

function eventKey(event: HostEvent): string {
	const value = event.data[event.event] as { id?: string } | undefined;
	return `${event.event}:${value?.id ?? ''}`;
}

export class CatalogStream {
	private previous = new Map<string, HostEvent>();
	private cursor = 0;
	private readonly epoch = crypto.randomUUID();

	constructor(private types: string | undefined) {}

	async change(event: HostEvent, send: SendEvent) {
		if (event.event.endsWith('.removed') && typeof event.data.id === 'string') {
			if (!this.previous.delete(`${event.event.replace(/\.removed$/, '')}:${event.data.id}`))
				return;
		} else {
			const key = eventKey(event);
			if (this.unchanged(key, event)) return;
			this.previous.set(key, event);
		}
		await this.emit(event, send);
	}

	async update(events: HostEvent[], send: SendEvent, initial: boolean) {
		const current = new Map(events.map((event) => [eventKey(event), event]));
		// Children disappear before their parents.
		for (const [key, event] of [...this.previous].reverse()) {
			if (current.has(key)) continue;
			const value = event.data[event.event] as { id: string };
			await this.emit(
				{ event: `${event.event}.removed`, data: { id: value.id, time: new Date().toISOString() } },
				send,
			);
		}
		for (const [key, event] of current) {
			if (this.unchanged(key, event)) continue;
			if (initial) {
				if (acceptsEvent(this.types, event.event)) await send(event);
			} else {
				await this.emit(
					{ ...event, data: { ...event.data, time: new Date().toISOString() } },
					send,
				);
			}
		}
		this.previous = current;
		if (initial) await this.emit({ event: 'ready', data: {} }, send);
	}

	private unchanged(key: string, event: HostEvent): boolean {
		return (
			JSON.stringify(this.previous.get(key)?.data[event.event]) ===
			JSON.stringify(event.data[event.event])
		);
	}

	private async emit(event: HostEvent, send: SendEvent) {
		const id = `${this.epoch}:${++this.cursor}`;
		if (acceptsEvent(this.types, event.event)) await send({ ...event, id });
	}
}
