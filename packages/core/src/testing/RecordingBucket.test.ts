import { describe, expect, it } from 'vitest';
import { bucketContract } from './bucketContract';
import { MemoryBucket } from './MemoryBucket';
import { RecordingBucket } from './RecordingBucket';

// The wrapper must be a faithful pass-through: it satisfies the same contract as
// the bucket it decorates.
bucketContract('RecordingBucket', () => new RecordingBucket(new MemoryBucket()));

describe('RecordingBucket recording', () => {
	it('records calls in order with put byte counts', async () => {
		const rec = new RecordingBucket(new MemoryBucket());

		await rec.put('a', 'hello'); // 5 bytes
		await rec.put('b', new Uint8Array(3));
		await rec.get('a');
		await rec.head('b');
		await rec.list({ prefix: 'a' });
		await rec.delete(['a', 'b']);

		expect(rec.calls.put).toEqual([
			{ key: 'a', bytes: 5 },
			{ key: 'b', bytes: 3 },
		]);
		expect(rec.calls.get).toEqual(['a']);
		expect(rec.calls.head).toEqual(['b']);
		expect(rec.calls.list).toEqual([{ prefix: 'a' }]);
		expect(rec.calls.delete).toEqual([['a', 'b']]);
	});

	it('defaults to an in-memory inner bucket when none is supplied', async () => {
		const rec = new RecordingBucket();
		await rec.put('k', 'v');
		expect(await (await rec.get('k'))!.text()).toBe('v');
	});
});
