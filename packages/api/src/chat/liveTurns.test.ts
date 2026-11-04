import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { registerLiveTurn, stopLiveTurn, subscribeLiveTurn } from './liveTurns';

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
	const chunks: UIMessageChunk[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

describe('live turn registry', () => {
	it('replays earlier chunks to a late subscriber and follows until release', async () => {
		const live = registerLiveTurn('p', 'c1', new AbortController());
		live.publish({ type: 'start', messageId: 'm' });
		live.publish({ type: 'text-start', id: 't' });
		const replay = drain(subscribeLiveTurn('p', 'c1')!);
		live.publish({ type: 'text-delta', id: 't', delta: 'hi' });
		live.release();
		expect((await replay).map((chunk) => chunk.type)).toEqual([
			'start',
			'text-start',
			'text-delta',
		]);
		expect(subscribeLiveTurn('p', 'c1')).toBeNull();
	});

	it('keeps publishing after a subscriber cancels or stops reading', async () => {
		const live = registerLiveTurn('p', 'c2', new AbortController());
		live.publish({ type: 'start', messageId: 'm' });
		const cancelled = subscribeLiveTurn('p', 'c2')!;
		const reader = cancelled.getReader();
		await reader.read();
		await reader.cancel();
		// Closed without cancel: enqueue would throw on this one.
		const closedEarly = subscribeLiveTurn('p', 'c2')!;
		const earlyReader = closedEarly.getReader();
		await earlyReader.read();
		earlyReader.releaseLock();
		await closedEarly.cancel();
		const survivor = drain(subscribeLiveTurn('p', 'c2')!);
		expect(() => live.publish({ type: 'text-start', id: 't' })).not.toThrow();
		expect(() => live.publish({ type: 'finish' })).not.toThrow();
		expect(() => live.release()).not.toThrow();
		expect((await survivor).map((chunk) => chunk.type)).toEqual(['start', 'text-start', 'finish']);
	});

	it('stops only a turn this process owns', () => {
		const controller = new AbortController();
		const live = registerLiveTurn('p', 'c3', controller);
		expect(stopLiveTurn('p', 'elsewhere', new Error('stop'))).toBe(false);
		expect(stopLiveTurn('p', 'c3', new Error('stop'))).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		live.release();
		expect(stopLiveTurn('p', 'c3', new Error('stop'))).toBe(false);
	});

	it('does not let a released turn be replaced by a stale release', () => {
		const first = registerLiveTurn('p', 'c4', new AbortController());
		const second = registerLiveTurn('p', 'c4', new AbortController());
		first.release();
		expect(subscribeLiveTurn('p', 'c4')).not.toBeNull();
		second.release();
		expect(subscribeLiveTurn('p', 'c4')).toBeNull();
	});
});
