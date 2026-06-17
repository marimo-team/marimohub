import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { IdempotencyService } from './IdempotencyService';

describe('IdempotencyService', () => {
	afterEach(() => vi.useRealTimers());

	it('returns null before a key is recorded, the data after', async () => {
		const svc = new IdempotencyService(new MemoryBucket());
		expect(await svc.lookup('u1:POST /projects', 'k1')).toBeNull();

		await svc.record('u1:POST /projects', 'k1', { id: 'proj-1' });
		expect(await svc.lookup('u1:POST /projects', 'k1')).toEqual({ data: { id: 'proj-1' } });
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

	it('prune writes under the _system/idempotency/ prefix', async () => {
		const bucket = new MemoryBucket();
		await new IdempotencyService(bucket).record('u1:POST /projects', 'k1', { id: 'proj-1' });

		const { objects } = await bucket.list({ prefix: paths.idempotencyPrefix });
		expect(objects).toHaveLength(1);
		expect(objects[0].key).toMatch(/^_system\/idempotency\/[0-9a-f]{64}\.json$/);
	});
});
