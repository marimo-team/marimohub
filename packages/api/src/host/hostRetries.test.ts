import { describe, expect, it, vi } from 'vitest';
import { HostRetryStore } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { hostRetriesFor, hostRetryStoreContract } from '@marimo-hub/host-protocol/testing';
import { hubErrorStatus } from './platform';

hostRetryStoreContract('HostRetryStore', () => new HostRetryStore(new MemoryBucket()), {
	errorStatus: hubErrorStatus,
});

describe('bucket-backed host retries', () => {
	it('retains the runtime binding when a retry reaches another API process', async () => {
		const bucket = new MemoryBucket();
		await expect(
			hostRetriesFor(new HostRetryStore(bucket), hubErrorStatus).execute(
				'user',
				'save',
				'fingerprint',
				async (attempt) => {
					await attempt.bindSession('original');
					throw new Error('Lost runtime reply');
				},
			),
		).rejects.toThrow('Lost runtime reply');
		let bound: string | undefined;
		const result = await hostRetriesFor(new HostRetryStore(bucket), hubErrorStatus).execute(
			'user',
			'save',
			'fingerprint',
			async (attempt) => {
				bound = attempt.sessionId;
				return { status: 200, body: {} };
			},
		);
		expect(result.status).toBe(200);
		expect(bound).toBe('original');
	});

	it('returns 503 without invoking work when retry storage is unavailable', async () => {
		const bucket = new MemoryBucket();
		vi.spyOn(bucket, 'get').mockRejectedValue(new Error('private storage details'));
		const work = vi.fn(async () => ({ status: 201, body: {} }));
		await expect(
			hostRetriesFor(new HostRetryStore(bucket), hubErrorStatus).execute(
				'user',
				'key',
				'create',
				work,
			),
		).rejects.toMatchObject({ status: 503 });
		expect(work).not.toHaveBeenCalled();
	});
});
