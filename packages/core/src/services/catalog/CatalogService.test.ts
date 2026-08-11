import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ACTOR, makeCatalog, makeSnapshot, MemoryBucket, setupTestEnv } from '../../testing';
import { ConflictError, NotInitializedError, PreconditionFailedError } from '../../errors';
import { createSnapshotId } from '../../ids';
import { paths } from '../../paths';
import { noopMetrics } from '../../ports/metrics';
import { EventSchema, SnapshotSchema } from '../../schema';
import type { Snapshot } from '../../schema';
import { CatalogService } from './CatalogService';
import { EventService } from './EventService';

// Exhaustion tests should not spend 750 ms in production backoff timers.
const ZERO_BACKOFF = { backoffMs: () => 0 };

describe('CatalogService', () => {
	let bucket: MemoryBucket;
	let catalog: CatalogService;

	beforeEach(async () => {
		bucket = new MemoryBucket();
		catalog = new CatalogService(bucket, noopMetrics, undefined, ZERO_BACKOFF);
	});

	describe('initialize', () => {
		it('creates catalog and empty snapshot', async () => {
			const snapshot = await catalog.initialize(ACTOR);

			expect(snapshot.projects).toEqual([]);
			expect(snapshot.operation).toBe('system.initialize');
			expect(snapshot.actor).toBe(ACTOR);

			const catalogObj = await bucket.get(paths.catalog);
			expect(catalogObj).not.toBeNull();

			const snapshotObj = await bucket.get(paths.snapshot(snapshot.snapshot_id));
			expect(snapshotObj).not.toBeNull();
		});

		it('is idempotent — returns current snapshot if catalog exists', async () => {
			const first = await catalog.initialize(ACTOR);
			const second = await catalog.initialize(ACTOR);
			expect(second.snapshot_id).toBe(first.snapshot_id);
		});

		it('second initialize does not overwrite the catalog', async () => {
			await catalog.initialize(ACTOR);
			const afterFirst = await bucket.get(paths.catalog);
			const idAfterFirst = (await afterFirst!.json<any>()).current_snapshot_id;

			await catalog.initialize(ACTOR);
			const afterSecond = await bucket.get(paths.catalog);
			const idAfterSecond = (await afterSecond!.json<any>()).current_snapshot_id;

			// The conditional create-if-absent put must reject the second writer
			// rather than clobbering the committed catalog.
			expect(idAfterSecond).toBe(idAfterFirst);
		});

		it('concurrent initialize calls converge on exactly one catalog', async () => {
			// Bypass the early get() short-circuit so both calls reach the
			// create-if-absent put and genuinely race on the same empty bucket.
			const results = await Promise.all([catalog.initialize(ACTOR), catalog.initialize(ACTOR)]);

			// Both calls resolve (the loser returns the winner's committed state).
			expect(results).toHaveLength(2);

			// Exactly one valid catalog exists and getCurrentSnapshot() succeeds.
			const current = await catalog.getCurrentSnapshot();
			const catalogObj = await bucket.get(paths.catalog);
			const catalogData = await catalogObj!.json<any>();
			expect(catalogData.current_snapshot_id).toBe(current.snapshot_id);

			// Both callers agree on the same committed snapshot id.
			expect(results[0].snapshot_id).toBe(results[1].snapshot_id);
			expect(results[0].snapshot_id).toBe(current.snapshot_id);

			// At most one orphan snapshot from the losing writer (best-effort
			// deleted), so no more than 2 snapshot objects total.
			const snaps = await bucket.list({ prefix: '_system/snapshots/' });
			expect(snaps.objects.length).toBeLessThanOrEqual(2);
		});

		it('propagates a non-precondition error from the create-if-absent put', async () => {
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key === paths.catalog && opts?.onlyIfNotExists) {
					throw new Error('catalog put boom');
				}
				return originalPut(key, value, opts);
			};

			await expect(catalog.initialize(ACTOR)).rejects.toThrow('catalog put boom');
		});
	});

	describe('getCurrentSnapshot', () => {
		it('throws if catalog not initialized', async () => {
			await expect(catalog.getCurrentSnapshot()).rejects.toThrow('Catalog not found');
		});

		it('throws NotInitializedError on an uninitialized bucket', async () => {
			await expect(catalog.getCurrentSnapshot()).rejects.toBeInstanceOf(NotInitializedError);
		});

		it('returns the current snapshot after initialization', async () => {
			const init = await catalog.initialize(ACTOR);
			const current = await catalog.getCurrentSnapshot();
			expect(current.snapshot_id).toBe(init.snapshot_id);
		});

		it('throws NotInitializedError when the catalog points at a missing snapshot', async () => {
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(createSnapshotId())));
			await expect(catalog.getCurrentSnapshot()).rejects.toBeInstanceOf(NotInitializedError);
		});

		it('throws a corrupted-object error on malformed catalog JSON', async () => {
			await bucket.put(paths.catalog, JSON.stringify({ bad: true }));
			await expect(catalog.getCurrentSnapshot()).rejects.toThrow(
				'Stored data is temporarily unavailable',
			);
		});
	});

	describe('mutateSnapshot', () => {
		beforeEach(async () => {
			await catalog.initialize(ACTOR);
		});

		it('creates a new snapshot with the mutation applied', async () => {
			const result = await catalog.mutateSnapshot('test.op', ACTOR, (snap: Snapshot) => ({
				...snap,
				projects: [
					...snap.projects,
					{
						id: 'proj-7h2k9qm4xz7rp3w8' as any,
						name: 'New',
						description: '',
						owner: ACTOR,
						status: 'active',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						notebook_count: 0,
						notebooks: [],
					},
				],
			}));

			expect(result.operation).toBe('test.op');
			expect(result.projects).toHaveLength(1);
			expect(result.projects[0].name).toBe('New');
		});

		it('awaits an asynchronous mutation', async () => {
			const result = await catalog.mutateSnapshot('test.async', ACTOR, async (snapshot) => {
				await Promise.resolve();
				return {
					...snapshot,
					projects: [
						{
							id: 'proj-7h2k9qm4xz7rp3w8' as any,
							name: 'Async',
							description: '',
							owner: ACTOR,
							status: 'active',
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
							notebook_count: 0,
							notebooks: [],
						},
					],
				};
			});

			expect(result.projects[0].name).toBe('Async');
		});

		it('preserves snapshot chain — previous_snapshot_id is set', async () => {
			const before = await catalog.getCurrentSnapshot();
			await catalog.mutateSnapshot('test', ACTOR, (s) => s);

			const catalogObj = await bucket.get(paths.catalog);
			const catalogData = await catalogObj!.json<any>();
			expect(catalogData.previous_snapshot_id).toBe(before.snapshot_id);
		});

		it('retries on concurrent writes and eventually succeeds', async () => {
			let callCount = 0;

			// Intercept put to simulate a concurrent write on first attempt
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key === paths.catalog && opts?.onlyIfEtagMatches && callCount === 0) {
					callCount++;
					// Simulate another writer committing first: bump the catalog's
					// ETag while leaving it pointed at a snapshot that still exists.
					const current = await bucket.get(paths.catalog);
					await originalPut(key, await current!.text());
					// Now throw as if our etag is stale
					throw new PreconditionFailedError('simulated race');
				}
				return originalPut(key, value, opts);
			};

			const result = await catalog.mutateSnapshot('test', ACTOR, (s) => s);
			expect(result).toBeDefined();
			expect(callCount).toBe(1); // retried once
		});

		it('throws ConflictError after max retries', async () => {
			// Always fail the conditional PUT
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key === paths.catalog && opts?.onlyIfEtagMatches) {
					throw new PreconditionFailedError('always fail');
				}
				return originalPut(key, value, opts);
			};

			await expect(catalog.mutateSnapshot('test', ACTOR, (s) => s)).rejects.toThrow(ConflictError);
		});

		it('deletes the orphan snapshot it wrote when the CAS swap loses the race', async () => {
			const snapshotPuts: string[] = [];
			let raced = false;
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key.startsWith(paths.snapshotsPrefix)) snapshotPuts.push(key);
				if (key === paths.catalog && opts?.onlyIfEtagMatches && !raced) {
					raced = true;
					// Bump the catalog ETag so the retry re-reads and can commit.
					const current = await bucket.get(paths.catalog);
					await originalPut(key, await current!.text());
					throw new PreconditionFailedError('simulated race');
				}
				return originalPut(key, value, opts);
			};

			await catalog.mutateSnapshot('test', ACTOR, (s) => s);

			// The losing attempt's orphan + the winning commit.
			expect(snapshotPuts).toHaveLength(2);
			// The orphan was cleaned up; the committed snapshot remains.
			expect(await bucket.get(snapshotPuts[0])).toBeNull();
			expect(await bucket.get(snapshotPuts[1])).not.toBeNull();
		});

		it('propagates immediately (no retry, no orphan) when the snapshot put fails', async () => {
			const increment = vi.fn();
			const svc = new CatalogService(bucket, { increment, gauge: vi.fn() });
			const before = (await bucket.list({ prefix: paths.snapshotsPrefix })).objects.length;

			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key.startsWith(paths.snapshotsPrefix)) throw new Error('snapshot put boom');
				return originalPut(key, value, opts);
			};

			await expect(svc.mutateSnapshot('test', ACTOR, (s) => s)).rejects.toThrow(
				'snapshot put boom',
			);

			// A non-precondition error is not retried.
			expect(increment.mock.calls.filter(([n]) => n === 'catalog.cas.attempt')).toHaveLength(1);
			// Nothing was written (the failed put left no orphan).
			expect((await bucket.list({ prefix: paths.snapshotsPrefix })).objects.length).toBe(before);
		});

		it('does not retry and writes nothing when mutateFn throws', async () => {
			const increment = vi.fn();
			const svc = new CatalogService(bucket, { increment, gauge: vi.fn() });
			const before = (await bucket.list({ prefix: paths.snapshotsPrefix })).objects.length;

			const boom = new Error('mutate boom');
			await expect(
				svc.mutateSnapshot('test', ACTOR, () => {
					throw boom;
				}),
			).rejects.toBe(boom);

			expect(increment.mock.calls.filter(([n]) => n === 'catalog.cas.attempt')).toHaveLength(1);
			expect((await bucket.list({ prefix: paths.snapshotsPrefix })).objects.length).toBe(before);
		});

		it('throws NotInitializedError without retrying when the snapshot pointer dangles', async () => {
			const increment = vi.fn();
			const svc = new CatalogService(bucket, { increment, gauge: vi.fn() });
			const current = await svc.getCurrentSnapshot();
			// Leave the catalog pointing at a snapshot that no longer exists.
			await bucket.delete(paths.snapshot(current.snapshot_id));

			await expect(svc.mutateSnapshot('test', ACTOR, (s) => s)).rejects.toBeInstanceOf(
				NotInitializedError,
			);
			expect(increment.mock.calls.filter(([n]) => n === 'catalog.cas.attempt')).toHaveLength(1);
		});

		it('throws a corrupted-object error on malformed catalog JSON', async () => {
			await bucket.put(paths.catalog, JSON.stringify({ not: 'a catalog' }));
			await expect(catalog.mutateSnapshot('test', ACTOR, (s) => s)).rejects.toThrow(
				/Stored data is temporarily unavailable/,
			);
		});

		it('throws a corrupted-object error on a malformed snapshot object', async () => {
			const current = await catalog.getCurrentSnapshot();
			await bucket.put(paths.snapshot(current.snapshot_id), JSON.stringify({ nope: true }));
			await expect(catalog.mutateSnapshot('test', ACTOR, (s) => s)).rejects.toThrow(
				/Stored data is temporarily unavailable/,
			);
		});

		it('ignores a mutateFn-lowered schema_version (stamps the read version)', async () => {
			const result = await catalog.mutateSnapshot('test', ACTOR, (s) => ({
				...s,
				schema_version: 0 as unknown as 1,
			}));
			expect(result.schema_version).toBe(1);
		});
	});

	describe('forward-read tolerance (schema_version > 1)', () => {
		it('parses an otherwise-valid snapshot with schema_version: 2 without throwing', () => {
			// A future v2 snapshot (e.g. written by a newer replica during a rolling
			// deploy) must not crash an older reader. The read schema tolerates any
			// positive integer schema_version; normalization is the upgrade seam's job.
			const v2 = { ...makeSnapshot(), schema_version: 2 };

			expect(() => SnapshotSchema.parse(v2)).not.toThrow();
			expect(SnapshotSchema.parse(v2).schema_version).toBe(2);
		});

		it('getCurrentSnapshot reads back a stored v2 snapshot without throwing', async () => {
			// Hand-place a catalog + v2 snapshot directly in the bucket, as a newer
			// replica would have written it, then read it through the service.
			const snapshot = { ...makeSnapshot(), schema_version: 2 };
			await bucket.put(paths.snapshot(snapshot.snapshot_id), JSON.stringify(snapshot));
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(snapshot.snapshot_id)));

			const current = await catalog.getCurrentSnapshot();
			expect(current.schema_version).toBe(2);
			expect(current.snapshot_id).toBe(snapshot.snapshot_id);
		});
	});

	describe('rolling-deploy write compatibility', () => {
		beforeEach(async () => {
			await catalog.initialize(ACTOR);
		});

		it('never downgrades schema_version and preserves unknown fields on commit', async () => {
			// Simulate a newer replica having committed a v2 snapshot carrying a field
			// this (older) code doesn't know about.
			const v2 = { ...makeSnapshot(), schema_version: 2, future_field: 'keep-me' };
			await bucket.put(paths.snapshot(v2.snapshot_id), JSON.stringify(v2));
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(v2.snapshot_id)));

			const result = await catalog.mutateSnapshot('test.op', ACTOR, (s) => s);

			// Downgrade-guard: the committed version is the max of read vs current code.
			expect(result.schema_version).toBe(2);

			// looseObject: the unknown field survives the read→mutate→write round-trip.
			const newObj = await bucket.get(paths.snapshot(result.snapshot_id));
			const raw = await newObj!.json<any>();
			expect(raw.schema_version).toBe(2);
			expect(raw.future_field).toBe('keep-me');
		});
	});

	describe('metrics', () => {
		it('emits CAS conflict + exhausted counters under contention', async () => {
			const increment = vi.fn();
			const instrumented = new CatalogService(
				bucket,
				{ increment, gauge: vi.fn() },
				undefined,
				ZERO_BACKOFF,
			);
			await instrumented.initialize(ACTOR);

			// Always fail the conditional catalog swap.
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key === paths.catalog && opts?.onlyIfEtagMatches) {
					throw new PreconditionFailedError('always fail');
				}
				return originalPut(key, value, opts);
			};

			await expect(instrumented.mutateSnapshot('t', ACTOR, (s) => s)).rejects.toThrow(
				ConflictError,
			);
			expect(increment).toHaveBeenCalledWith('catalog.cas.conflict');
			expect(increment).toHaveBeenCalledWith('catalog.cas.exhausted');
		});
	});

	describe('audit events', () => {
		let events: EventService;
		let audited: CatalogService;

		beforeEach(async () => {
			events = new EventService(bucket);
			audited = new CatalogService(bucket, noopMetrics, events);
			await audited.initialize(ACTOR);
		});

		const listEvents = async () => (await bucket.list({ prefix: paths.eventsPrefix })).objects;

		it('appends exactly one event per successful mutation, with context', async () => {
			await audited.mutateSnapshot('project.update', ACTOR, (s) => s, {
				project_id: 'proj-7h2k9qm4xz7rp3w8',
			});

			const objects = await listEvents();
			expect(objects).toHaveLength(1);
			const event = EventSchema.parse(await (await bucket.get(objects[0].key))!.json());
			expect(event.event).toBe('project.update');
			expect(event.actor).toBe(ACTOR);
			expect((event as any).project_id).toBe('proj-7h2k9qm4xz7rp3w8');
		});

		it('writes exactly one event when the CAS loses a race and retries', async () => {
			let callCount = 0;
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key === paths.catalog && opts?.onlyIfEtagMatches && callCount === 0) {
					callCount++;
					const current = await bucket.get(paths.catalog);
					await originalPut(key, await current!.text());
					throw new PreconditionFailedError('simulated race');
				}
				return originalPut(key, value, opts);
			};

			await audited.mutateSnapshot('project.update', ACTOR, (s) => s);

			expect(callCount).toBe(1); // the race actually happened
			expect(await listEvents()).toHaveLength(1);
		});

		it('a failing append does not fail the mutation and bumps events.append_failed', async () => {
			const increment = vi.fn();
			const flaky = new CatalogService(bucket, { increment, gauge: vi.fn() }, events);
			vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('events boom'));

			const result = await flaky.mutateSnapshot('project.update', ACTOR, (s) => s);

			expect(result.operation).toBe('project.update');
			expect(increment).toHaveBeenCalledWith('events.append_failed');
			expect(await listEvents()).toHaveLength(0);
		});

		it('writes no events when no EventService is injected', async () => {
			await catalog.mutateSnapshot('project.update', ACTOR, (s) => s);
			expect(await listEvents()).toHaveLength(0);
		});
	});

	describe('concurrent mutateSnapshot calls', () => {
		it('both succeed without data loss', async () => {
			const env = await setupTestEnv();

			// Create two projects concurrently
			const [r1, r2] = await Promise.all([
				env.projects.createProject({ name: 'P1', description: 'first' }, ACTOR),
				env.projects.createProject({ name: 'P2', description: 'second' }, ACTOR),
			]);

			expect(r1).toBeDefined();
			expect(r2).toBeDefined();

			// Both should appear in the snapshot
			const snap = await env.catalog.getCurrentSnapshot();
			const names = snap.projects.map((p) => p.name).sort();
			expect(names).toEqual(['P1', 'P2']);
		});
	});
});
