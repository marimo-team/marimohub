import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceLock } from '../services/catalog/MaintenanceLock';
import { MemoryBucket } from '../testing/MemoryBucket';
import { createLogicalStorage } from './logicalBucket';
import { classifyMetadataKey } from './metadataKeys';
import { validateMetadataRecord } from './metadataValidation';

const keys = [
	'_system/app-pool-maintenance-lock.json',
	'_system/retention-notebook_gc-lock.json',
	'_system/retention-snapshot_expiry-lock.json',
	'_system/retention-jobs-lock.json',
];

const validRecord = { holder: 'replica-a', expires_at: '2026-01-01T00:00:00.000Z' };

afterEach(() => vi.restoreAllMocks());

describe('server maintenance metadata', () => {
	it.each(keys)('routes %s through shared metadata with fenced release', async (key) => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(0);
		const artifacts = new MemoryBucket();
		const metadata = new MemoryBucket();
		const replica = () =>
			createLogicalStorage(artifacts, metadata, { namespace: 'test', epoch: 1 }).logicalBucket;
		const first = new MaintenanceLock(replica(), key);
		const second = new MaintenanceLock(replica(), key);
		expect(await first.acquire('replica-a', 1000)).toBe(true);
		await first.release('wrong-owner');
		expect(await second.acquire('replica-b', 1000)).toBe(false);
		expect(await artifacts.get(key)).toBeNull();
		await validateMetadataRecord((await metadata.get(key))!);

		now.mockReturnValue(1000);
		expect(await second.acquire('replica-b', 1000)).toBe(true);
		const successor = (await metadata.get(key))!;
		await first.release('replica-a');
		expect((await metadata.get(key))!.etag).toBe(successor.etag);
		expect(await first.acquire('replica-a', 1000)).toBe(false);
		await second.release('replica-b');
		await validateMetadataRecord((await metadata.get(key))!);
		expect(await first.acquire('replica-a', 1000)).toBe(true);
	});

	describe.each(keys)('%s owner validation', (key) => {
		it.each([
			['invalid holder', JSON.stringify({ ...validRecord, holder: 123 })],
			['invalid expiry', JSON.stringify({ ...validRecord, expires_at: 'invalid' })],
			['missing holder', JSON.stringify({ expires_at: validRecord.expires_at })],
			['missing expiry', JSON.stringify({ holder: validRecord.holder })],
			['invalid JSON', 'not-json'],
		])('rejects %s during transfer validation', async (_, body) => {
			const metadata = new MemoryBucket();
			await metadata.put(key, body);
			await expect(validateMetadataRecord((await metadata.get(key))!)).rejects.toThrow(
				'Invalid metadata record',
			);
		});
	});

	it.each([
		'_system/_maintenance.lock',
		'_system/_session_lifecycle.lock',
		'_system/_jobs.lock',
		'_system/_warm_pool.lock',
		'_system/search/lock.json',
	])('keeps existing lock %s classified and validated', async (key) => {
		const metadata = new MemoryBucket();
		await metadata.put(key, JSON.stringify(validRecord));
		expect(classifyMetadataKey(key)).toBe('metadata');
		await validateMetadataRecord((await metadata.get(key))!);
	});

	it.each([
		'_system/retention-unknown-lock.json',
		'_system/arbitrary-maintenance-lock.json',
		'_system/app-pool-maintenance-lock.json/child',
		'_system/retention-jobs-lock.json.bak',
		'_system/_arbitrary.lock',
		'prefix/_system/app-pool-maintenance-lock.json',
	])('keeps undeclared maintenance keys closed: %s', (key) => {
		expect(() => classifyMetadataKey(key)).toThrow('Unclassified storage key');
	});
});
