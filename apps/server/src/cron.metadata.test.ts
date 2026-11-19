import { describe, expect, it } from 'vitest';
import { createInitializedBucket, makeTestDeps } from '@marimo-hub/api/testing';
import { createServices } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createLogicalStorage } from '@marimo-hub/core/storage/logical-bucket';
import { validateMetadataRecord } from '@marimo-hub/core/storage/metadata-validation';
import { BackgroundLoops } from './backgroundLoops';
import { startMaintenance } from './cron';
import { WideEventMetrics } from './metrics';
import { flushRun, useLoopHarness } from './test/loopHarness';

describe('maintenance with separate metadata storage', () => {
	const h = useLoopHarness();

	it('runs app-pool and retention sweeps with jobs enabled', async () => {
		const artifacts = new MemoryBucket();
		const metadata = await createInitializedBucket();
		const { logicalBucket } = createLogicalStorage(artifacts, metadata, {
			namespace: 'test',
			epoch: 1,
		});
		const deps = makeTestDeps(metadata, {
			bucket: logicalBucket,
			services: createServices(logicalBucket),
		});
		expect(deps.jobs).toBeDefined();
		const loops = new BackgroundLoops();
		const stop = h.track(startMaintenance(deps, new WideEventMetrics(), loops));
		await flushRun();
		stop();
		await loops.drain();

		expect(h.events().filter(({ event }) => String(event).endsWith('_failed'))).toEqual([]);
		for (const key of [
			'_system/app-pool-maintenance-lock.json',
			'_system/retention-notebook_gc-lock.json',
			'_system/retention-snapshot_expiry-lock.json',
			'_system/retention-jobs-lock.json',
		]) {
			const record = await metadata.get(key);
			expect(record, key).not.toBeNull();
			await validateMetadataRecord(record!);
			expect(await artifacts.get(key)).toBeNull();
		}
	});
});
