import { describe, expect, it, vi } from 'vitest';
import type { HostEvent } from '@marimo-hub/core/host-bridge';
import { CatalogStream } from './streams';

function attachment(name = 'Editor'): HostEvent {
	return {
		event: 'attachment',
		data: { attachment: { id: 'attachment-1', notebook_id: 'notebook-1', name } },
	};
}

describe('CatalogStream', () => {
	it.each([true, false])(
		'suppresses a queued attachment already in the snapshot (initial=%s)',
		async (initial) => {
			const stream = new CatalogStream(undefined);
			const send = vi.fn(async (_event: HostEvent) => {});
			const event = attachment();
			await stream.update([event], send, initial);
			await stream.change({ ...event, data: { ...event.data, time: 'later' } }, send);
			expect(send.mock.calls.map(([entry]) => entry.event)).toEqual(
				initial ? ['attachment', 'ready'] : ['attachment'],
			);
		},
	);

	it('suppresses removals already emitted by a snapshot', async () => {
		const stream = new CatalogStream(undefined);
		const send = vi.fn(async (_event: HostEvent) => {});
		await stream.update([attachment()], send, true);
		send.mockClear();
		await stream.update([], send, false);
		await stream.change({ event: 'attachment.removed', data: { id: 'attachment-1' } }, send);
		expect(send.mock.calls.map(([entry]) => entry.event)).toEqual(['attachment.removed']);
	});

	it('preserves changes after the snapshot and subsequent attachment lifecycles', async () => {
		const stream = new CatalogStream(undefined);
		const send = vi.fn(async (_event: HostEvent) => {});
		await stream.update([attachment()], send, true);
		send.mockClear();
		await stream.change(attachment('Renamed editor'), send);
		await stream.change({ event: 'attachment.removed', data: { id: 'attachment-1' } }, send);
		await stream.change(attachment(), send);
		await stream.update([attachment()], send, false);
		expect(send.mock.calls.map(([entry]) => entry.event)).toEqual([
			'attachment',
			'attachment.removed',
			'attachment',
		]);
		expect(send.mock.calls[0][0].data).toEqual(attachment('Renamed editor').data);
		expect(new Set(send.mock.calls.map(([entry]) => entry.id)).size).toBe(3);
	});
});
