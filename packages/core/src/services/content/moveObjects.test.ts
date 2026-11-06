import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { copyMoveObject, copyMovePrefix } from './moveObjects';

describe('copyMoveObject', () => {
	it('preserves HTTP and custom metadata through copy and replay', async () => {
		const bucket = new MemoryBucket();
		const metadata = {
			httpMetadata: { contentType: 'image/png' },
			customMetadata: { integration: 'notebook-preview', revision: '42' },
		};
		await bucket.put('source/image.png', new Uint8Array([1, 2, 3]), metadata);
		await copyMoveObject(bucket, 'source/image.png', 'destination/image.png');
		await copyMoveObject(bucket, 'source/image.png', 'destination/image.png');
		expect(await bucket.head('destination/image.png')).toMatchObject(metadata);
		expect(await (await bucket.get('destination/image.png'))!.bytes()).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	it('rejects equal bytes with different destination metadata on retry', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('source', 'same bytes', {
			httpMetadata: { contentType: 'text/x-python' },
			customMetadata: { revision: 'new' },
		});
		await bucket.put('destination', 'same bytes', {
			httpMetadata: { contentType: 'text/plain' },
			customMetadata: { revision: 'old' },
		});
		await expect(copyMoveObject(bucket, 'source', 'destination')).rejects.toThrow('different data');
		expect(await bucket.head('destination')).toMatchObject({ customMetadata: { revision: 'old' } });
	});

	it('accepts reordered custom metadata and equivalent empty metadata on retry', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('source', 'data', { customMetadata: { first: '1', second: '2' } });
		await bucket.put('destination', 'data', { customMetadata: { second: '2', first: '1' } });
		await expect(copyMoveObject(bucket, 'source', 'destination')).resolves.toBeUndefined();
		await bucket.put('source', 'data');
		await bucket.put('destination', 'data', { httpMetadata: {}, customMetadata: {} });
		await expect(copyMoveObject(bucket, 'source', 'destination')).resolves.toBeUndefined();
	});

	it('rejects content and metadata read from different source revisions', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('source', 'old');
		const head = bucket.head.bind(bucket);
		vi.spyOn(bucket, 'head').mockImplementationOnce(async (key) => {
			await bucket.put(key, 'new');
			return head(key);
		});
		await expect(copyMoveObject(bucket, 'source', 'destination')).rejects.toThrow('source changed');
		expect(await bucket.get('destination')).toBeNull();
	});
});

describe('copyMovePrefix', () => {
	it('starts no copy after a failure and settles in-flight copies before rejecting', async () => {
		const bucket = new MemoryBucket();
		for (let i = 0; i < 20; i++) await bucket.put(`src/${String(i).padStart(2, '0')}`, `${i}`);
		const put = bucket.put.bind(bucket);
		const started: string[] = [];
		let inFlight = 0;
		let peak = 0;
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (!key.startsWith('dst/')) return put(key, value, options);
			started.push(key);
			peak = Math.max(peak, ++inFlight);
			try {
				await new Promise((resolve) => setTimeout(resolve, 5));
				if (key === 'dst/00') throw new Error('write failed');
				return await put(key, value, options);
			} finally {
				inFlight--;
			}
		});

		await expect(copyMovePrefix(bucket, 'src/', 'dst/')).rejects.toThrow('write failed');
		expect(inFlight).toBe(0);
		const attempted = started.length;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toHaveLength(attempted);
		expect(attempted).toBeLessThan(20);
		expect(peak).toBeLessThanOrEqual(4);
	});
});
