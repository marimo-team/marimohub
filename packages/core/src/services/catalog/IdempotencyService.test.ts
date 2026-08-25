import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { IdempotencyService } from './IdempotencyService';

describe('IdempotencyService', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns null before a key is recorded, the data after', async () => {
		const svc = new IdempotencyService(new MemoryBucket());
		expect(await svc.lookup('u1:POST /projects', 'k1')).toBeNull();

		await svc.record('u1:POST /projects', 'k1', { id: 'proj-1' });
		expect(await svc.lookup('u1:POST /projects', 'k1')).toEqual({ data: { id: 'proj-1' } });
	});

	it('atomically reserves only the first use of a scope and key', async () => {
		const svc = new IdempotencyService(new MemoryBucket());

		const claims = await Promise.all(
			Array.from({ length: 5 }, () => svc.reserve('u1:external-delivery', 'k1')),
		);

		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(await svc.reserve('u1:external-delivery', 'k1')).toBe(false);
		expect(await svc.reserve('u1:external-delivery', 'k2')).toBe(true);
		expect(await svc.reserve('u2:external-delivery', 'k1')).toBe(true);
	});

	it('releases an unused reservation for another attempt', async () => {
		const svc = new IdempotencyService(new MemoryBucket());

		expect(await svc.reserve('u1:external-delivery', 'k1')).toBe(true);
		await svc.releaseReservation('u1:external-delivery', 'k1');

		expect(await svc.reserve('u1:external-delivery', 'k1')).toBe(true);
	});

	it('does not release completed results or another scope', async () => {
		const svc = new IdempotencyService(new MemoryBucket());
		await svc.record('u1:POST /projects', 'completed', { id: 'proj-1' });
		expect(await svc.reserve('u1:external-delivery', 'reserved')).toBe(true);

		await svc.releaseReservation('u1:POST /projects', 'completed');
		await svc.releaseReservation('u2:external-delivery', 'reserved');

		expect(await svc.lookup('u1:POST /projects', 'completed')).toEqual({
			data: { id: 'proj-1' },
		});
		expect(await svc.reserve('u1:external-delivery', 'reserved')).toBe(false);
	});

	it('fails before reserving when storage cannot create the claim', async () => {
		const bucket = new MemoryBucket();
		const boom = new Error('put boom');
		vi.spyOn(bucket, 'put').mockRejectedValueOnce(boom);
		const svc = new IdempotencyService(bucket);

		await expect(svc.reserve('u1:external-delivery', 'k1')).rejects.toBe(boom);
		expect(await svc.lookup('u1:external-delivery', 'k1')).toBeNull();
	});

	it('does not reclaim a corrupt reservation', async () => {
		const bucket = new MemoryBucket();
		const svc = new IdempotencyService(bucket);
		expect(await svc.reserve('u1:external-delivery', 'k1')).toBe(true);
		const { objects } = await bucket.list({ prefix: paths.idempotencyPrefix });
		await bucket.put(objects[0].key, '{not-json');

		expect(await svc.reserve('u1:external-delivery', 'k1')).toBe(false);
	});

	it('scopes by (scope, key): a different key or scope misses', async () => {
		const svc = new IdempotencyService(new MemoryBucket());
		await svc.record('u1:POST /projects', 'k1', { id: 'proj-1' });

		expect(await svc.lookup('u1:POST /projects', 'k2')).toBeNull();
		expect(await svc.lookup('u2:POST /projects', 'k1')).toBeNull();
		expect(await svc.lookup('u1:POST /projects/{pid}/notebooks', 'k1')).toBeNull();
	});

	it('record is create-if-absent: a second record keeps the first value', async () => {
		const svc = new IdempotencyService(new MemoryBucket());
		await svc.record('u1:POST /projects', 'k1', { id: 'first' });
		await svc.record('u1:POST /projects', 'k1', { id: 'second' });

		expect(await svc.lookup('u1:POST /projects', 'k1')).toEqual({ data: { id: 'first' } });
	});

	it('replaces a corrupt record after treating lookup as a miss', async () => {
		const bucket = new MemoryBucket();
		const svc = new IdempotencyService(bucket);
		await svc.record('u1:POST /projects', 'k1', { id: 'first' });
		const { objects } = await bucket.list({ prefix: paths.idempotencyPrefix });
		await bucket.put(objects[0].key, '{"secret":"do-not-log"');
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			expect(await svc.lookup('u1:POST /projects', 'k1')).toBeNull();
			await svc.record('u1:POST /projects', 'k1', { id: 'recovered' });
			expect(await svc.lookup('u1:POST /projects', 'k1')).toEqual({
				data: { id: 'recovered' },
			});
			expect(
				log.mock.calls.some((call) =>
					String(call[0]).includes('corrupt_idempotency_record_replaced'),
				),
			).toBe(true);
			expect(log.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('do-not-log');
		} finally {
			log.mockRestore();
		}
	});

	it('keeps repair read failures non-fatal after a lost create race', async () => {
		const bucket = new MemoryBucket();
		const svc = new IdempotencyService(bucket);
		await svc.record('u1:POST /projects', 'k1', { id: 'first' });
		vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('transient read failure'));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(svc.record('u1:POST /projects', 'k1', { id: 'second' })).resolves.toBeUndefined();
		expect(log.mock.calls[0]?.[0]).toContain('idempotency_record_repair_failed');
	});

	it('keeps repair write failures non-fatal after a corrupt-record race', async () => {
		const bucket = new MemoryBucket();
		const svc = new IdempotencyService(bucket);
		await svc.record('u1:POST /projects', 'k1', { id: 'first' });
		const { objects } = await bucket.list({ prefix: paths.idempotencyPrefix });
		await bucket.put(objects[0].key, '{not-json');
		const originalPut = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation((key, value, options) => {
			if (options?.onlyIfEtagMatches) return Promise.reject(new Error('transient write failure'));
			return originalPut(key, value, options);
		});
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(
			svc.record('u1:POST /projects', 'k1', { id: 'recovered' }),
		).resolves.toBeUndefined();
		expect(log.mock.calls[0]?.[0]).toContain('idempotency_record_repair_failed');
	});

	it('prune deletes records past the retention window and keeps recent ones', async () => {
		vi.useFakeTimers();
		const bucket = new MemoryBucket();
		const svc = new IdempotencyService(bucket);

		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		await svc.record('u1:POST /projects', 'old', { id: 'old' });

		// Two days later the 24h-default sweep collects the old record.
		vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
		await svc.record('u1:POST /projects', 'fresh', { id: 'fresh' });

		expect(await svc.prune()).toBe(1);
		expect(await svc.lookup('u1:POST /projects', 'old')).toBeNull();
		expect(await svc.lookup('u1:POST /projects', 'fresh')).toEqual({ data: { id: 'fresh' } });
	});

	it('lookup returns null when the stored record scope does not match (hash-collision guard)', async () => {
		const bucket = new MemoryBucket();
		const svc = new IdempotencyService(bucket);
		await svc.record('u1:POST /projects', 'k1', { id: 'proj-1' });

		// Tamper the stored record's scope in place, simulating a digest collision
		// where a record for a different scope lands at the same object key.
		const { objects } = await bucket.list({ prefix: paths.idempotencyPrefix });
		const key = objects[0].key;
		const record = await (await bucket.get(key))!.json<any>();
		await bucket.put(key, JSON.stringify({ ...record, scope: 'u2:POST /other' }));

		expect(await svc.lookup('u1:POST /projects', 'k1')).toBeNull();
	});

	it('record rethrows a non-PreconditionFailed error from put', async () => {
		const bucket = new MemoryBucket();
		const boom = new Error('put boom');
		vi.spyOn(bucket, 'put').mockRejectedValue(boom);
		const svc = new IdempotencyService(bucket);

		await expect(svc.record('u1:POST /projects', 'k1', { id: 'x' })).rejects.toBe(boom);
	});

	it('prune writes under the _system/idempotency/ prefix', async () => {
		const bucket = new MemoryBucket();
		await new IdempotencyService(bucket).record('u1:POST /projects', 'k1', { id: 'proj-1' });

		const { objects } = await bucket.list({ prefix: paths.idempotencyPrefix });
		expect(objects).toHaveLength(1);
		expect(objects[0].key).toMatch(/^_system\/idempotency\/[0-9a-f]{64}\.json$/);
	});
});
