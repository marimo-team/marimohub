import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PostgresFrameGuard } from './worker';

describe('PostgresFrameGuard', () => {
	it('passes ordinary PostgreSQL frames without changing bytes', async () => {
		const frame = dataRow(Buffer.from('small'));
		const guard = new PostgresFrameGuard(() => 1024, vi.fn());

		expect(await throughGuard(guard, [frame.subarray(0, 2), frame.subarray(2)])).toEqual(frame);
	});

	it('discards an oversized data row and emits a bounded null row', async () => {
		const frame = dataRow(Buffer.alloc(80, 0x78));
		const onOversized = vi.fn();
		const guard = new PostgresFrameGuard(() => 32, onOversized);

		expect(
			await throughGuard(guard, [frame.subarray(0, 3), frame.subarray(3, 9), frame.subarray(9)]),
		).toEqual(dataRow(null));
		expect(onOversized).toHaveBeenCalledOnce();
	});
});

function dataRow(value: Buffer | null): Buffer {
	const valueBytes = value?.length ?? 0;
	const frame = Buffer.alloc(11 + valueBytes);
	frame[0] = 0x44;
	frame.writeUInt32BE(10 + valueBytes, 1);
	frame.writeUInt16BE(1, 5);
	frame.writeInt32BE(value === null ? -1 : valueBytes, 7);
	value?.copy(frame, 11);
	return frame;
}

async function throughGuard(guard: PostgresFrameGuard, chunks: Buffer[]): Promise<Buffer> {
	Readable.from(chunks).pipe(guard);
	const output: Buffer[] = [];
	for await (const chunk of guard) output.push(chunk as Buffer);
	return Buffer.concat(output);
}
