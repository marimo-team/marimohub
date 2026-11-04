import type { UIMessageChunk } from 'ai';

/**
 * In-process registry of running turns. It gives two things a bucket record
 * cannot: an immediate local stop, and a replay of every chunk emitted so far so
 * a client that reloads mid-turn re-attaches to the live stream instead of
 * polling. Turns owned by another replica are not here; those clients fall back
 * to the saved record, which the durable stop flag and consent decisions still
 * reach.
 */
class LiveTurn {
	readonly chunks: UIMessageChunk[] = [];
	private readonly subscribers = new Set<ReadableStreamDefaultController<UIMessageChunk>>();
	private closed = false;
	constructor(readonly controller: AbortController) {}

	publish(chunk: UIMessageChunk): void {
		if (this.closed) return;
		this.chunks.push(chunk);
		for (const subscriber of this.subscribers) this.deliver(subscriber, chunk);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const subscriber of this.subscribers) {
			try {
				subscriber.close();
			} catch {
				// Already cancelled by its reader.
			}
		}
		this.subscribers.clear();
	}

	/** Everything emitted so far, then live chunks until the turn ends. */
	subscribe(): ReadableStream<UIMessageChunk> {
		let own: ReadableStreamDefaultController<UIMessageChunk> | undefined;
		return new ReadableStream<UIMessageChunk>({
			start: (controller) => {
				own = controller;
				for (const chunk of this.chunks) controller.enqueue(chunk);
				if (this.closed) controller.close();
				else this.subscribers.add(controller);
			},
			cancel: () => {
				if (own) this.subscribers.delete(own);
			},
		});
	}

	// A reader that went away without cancelling makes enqueue throw; the turn
	// must outlive any one viewer, so drop that subscriber instead of failing.
	private deliver(
		subscriber: ReadableStreamDefaultController<UIMessageChunk>,
		chunk: UIMessageChunk,
	): void {
		try {
			subscriber.enqueue(chunk);
		} catch {
			this.subscribers.delete(subscriber);
		}
	}
}

const turns = new Map<string, LiveTurn>();

function turnKey(pid: string, cid: string): string {
	return `${pid}/${cid}`;
}

export function registerLiveTurn(pid: string, cid: string, controller: AbortController) {
	const key = turnKey(pid, cid);
	const turn = new LiveTurn(controller);
	turns.set(key, turn);
	return {
		publish: (chunk: UIMessageChunk) => turn.publish(chunk),
		release: () => {
			turn.close();
			if (turns.get(key) === turn) turns.delete(key);
		},
	};
}

/** Re-attach to a turn running in this process, or null when none is. */
export function subscribeLiveTurn(pid: string, cid: string): ReadableStream<UIMessageChunk> | null {
	return turns.get(turnKey(pid, cid))?.subscribe() ?? null;
}

/** Abort the turn running here. False when this process does not own it. */
export function stopLiveTurn(pid: string, cid: string, reason: Error): boolean {
	const turn = turns.get(turnKey(pid, cid));
	if (!turn) return false;
	turn.controller.abort(reason);
	return true;
}
