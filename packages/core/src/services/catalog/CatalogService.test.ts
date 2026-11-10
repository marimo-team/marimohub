import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ACTOR,
	makeCatalog,
	makeProject,
	makeSnapshot,
	makeSnapshotProjectEntry,
	MemoryBucket,
	queuedBackgroundWork,
	RecordingBucket,
	setupTestEnv,
	uid,
} from '../../testing';
import {
	ConflictError,
	NotFoundError,
	NotInitializedError,
	PreconditionFailedError,
} from '../../errors';
import { createNotebookId, createProjectId, createSnapshotId } from '../../ids';
import { paths } from '../../paths';
import { noopMetrics } from '../../ports/metrics';
import { EventSchema, SnapshotSchema } from '../../schema';
import type { Project, Snapshot, SnapshotProjectEntry } from '../../schema';
import { CatalogService } from './CatalogService';
import { createServices, ensureInitialized } from '../index';
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

	it('keeps committed catalog changes when a deferred audit fails and drains subsequent audits', async () => {
		await catalog.initialize(ACTOR);
		const host = queuedBackgroundWork();
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		const events = new EventService(bucket);
		const append = vi
			.spyOn(events, 'append')
			.mockRejectedValueOnce(new Error('audit storage unavailable'));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const service = new CatalogService(
				bucket,
				metrics,
				events,
				ZERO_BACKOFF,
				undefined,
				bucket,
				host.work,
			);
			for (const operation of ['first', 'second']) {
				await service.mutateSnapshot(operation, ACTOR, (snapshot) => ({
					...snapshot,
					projects: [...snapshot.projects, makeSnapshotProjectEntry()],
				}));
			}
			expect((await service.getCurrentSnapshot()).projects).toHaveLength(2);
			expect(append).not.toHaveBeenCalled();
			expect(host.labels).toEqual(['catalog.audit', 'catalog.audit']);
			await expect(host.runAll()).resolves.toBeUndefined();
			expect(metrics.increment).toHaveBeenCalledWith('events.append_failed');
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
				event: 'background_work_failed',
				operation: 'catalog.audit',
				audit_event: 'first',
				actor: ACTOR,
			});
			expect(metrics.increment).toHaveBeenCalledWith('background.failed', 1, {
				label: 'catalog.audit',
			});
			expect(append).toHaveBeenCalledTimes(2);
			expect((await service.getCurrentSnapshot()).projects).toHaveLength(2);
		} finally {
			log.mockRestore();
			append.mockRestore();
		}
	});

	it.each([false, true])('redacts audit provider failures (deferred=%s)', async (deferred) => {
		await catalog.initialize(ACTOR);
		const host = queuedBackgroundWork();
		const events = new EventService(bucket);
		vi.spyOn(events, 'append').mockRejectedValue(
			Object.assign(new Error('secret credential'), {
				reason: 'secret credential',
				object: 'secret credential',
			}),
		);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const service = new CatalogService(
				bucket,
				noopMetrics,
				events,
				ZERO_BACKOFF,
				undefined,
				bucket,
				deferred ? host.work : undefined,
			);
			await expect(
				service.mutateSnapshot('project.update', ACTOR, (s) => ({ ...s })),
			).resolves.toMatchObject({ operation: 'project.update' });
			await host.runAll();
			expect(log).toHaveBeenCalledWith(expect.stringContaining('catalog.audit'));
			expect(JSON.stringify(log.mock.calls)).not.toContain('secret credential');
		} finally {
			log.mockRestore();
		}
	});

	it('schedules one audit per winning concurrent commit', async () => {
		await catalog.initialize(ACTOR);
		const host = queuedBackgroundWork();
		const events = new EventService(bucket);
		const append = vi.spyOn(events, 'append');
		const service = new CatalogService(
			bucket,
			noopMetrics,
			events,
			ZERO_BACKOFF,
			undefined,
			bucket,
			host.work,
		);
		await Promise.all(
			['first', 'second'].map((operation) =>
				service.mutateSnapshot(operation, ACTOR, (snapshot) => ({
					...snapshot,
					projects: [...snapshot.projects, makeSnapshotProjectEntry()],
				})),
			),
		);
		expect((await service.getCurrentSnapshot()).projects).toHaveLength(2);
		expect(append).not.toHaveBeenCalled();
		expect(host.pending()).toBe(2);
		await host.runAll();
		expect(append.mock.calls.map(([event]) => event.event).sort()).toEqual(['first', 'second']);
	});

	describe('snapshot cache', () => {
		it('shares immutable loads while validating the pointer independently', async () => {
			await catalog.initialize(ACTOR);
			const get = vi.spyOn(bucket, 'get');
			const snapshots = await Promise.all([
				catalog.getCurrentSnapshot(),
				catalog.getCurrentSnapshot(),
			]);
			expect(snapshots[0]).toBe(snapshots[1]);
			expect(await catalog.getCurrentSnapshot()).toBe(snapshots[0]);
			expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(
				1,
			);
			expect(get.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(3);
			expect(get.mock.calls.at(-1)).toEqual([
				paths.catalog,
				{ ifNoneMatch: (await bucket.head(paths.catalog))!.etag },
			]);
		});

		it('retains two snapshot keys and evicts the least recently read', async () => {
			const snapshots = [makeSnapshot(), makeSnapshot(), makeSnapshot()];
			const pointAt = async (snapshot: Snapshot) => {
				await bucket.put(paths.catalog, JSON.stringify(makeCatalog(snapshot.snapshot_id)));
				return catalog.getCurrentSnapshot();
			};
			for (const snapshot of snapshots)
				await bucket.put(paths.snapshot(snapshot.snapshot_id), JSON.stringify(snapshot));
			const first = await pointAt(snapshots[0]);
			const second = await pointAt(snapshots[1]);
			expect(await pointAt(snapshots[0])).toBe(first);
			await pointAt(snapshots[2]);
			expect(await pointAt(snapshots[0])).toBe(first);
			const get = vi.spyOn(bucket, 'get');
			expect(await pointAt(snapshots[1])).toEqual(second);
			expect(
				get.mock.calls.filter(([key]) => key === paths.snapshot(second.snapshot_id)),
			).toHaveLength(1);
		});

		it('skips storage writes and audit events for an unchanged input', async () => {
			await catalog.initialize(ACTOR);
			const events = new EventService(bucket);
			const append = vi.spyOn(events, 'append');
			const service = new CatalogService(bucket, noopMetrics, events);
			const before = await service.getCurrentSnapshot();
			const put = vi.spyOn(bucket, 'put');
			expect(await service.mutateSnapshot('noop', ACTOR, (snapshot) => snapshot)).toBe(before);
			expect(put).not.toHaveBeenCalled();
			expect(append).not.toHaveBeenCalled();
		});

		it('reuses the cached serialization for an unchanged in-place mutator', async () => {
			await catalog.initialize(ACTOR);
			const committed = await catalog.mutateSnapshot('test', ACTOR, (snapshot) => ({
				...snapshot,
				projects: [makeSnapshotProjectEntry()],
			}));
			const stringify = vi.spyOn(JSON, 'stringify');
			try {
				const result = await catalog.mutateSnapshot('noop', ACTOR, (snapshot) => snapshot);
				expect(result).toBe(committed);
				expect(stringify.mock.calls.filter(([value]) => value === committed)).toEqual([]);
			} finally {
				stringify.mockRestore();
			}
		});

		it('observes a commit made through an independent cache over the same storage', async () => {
			await catalog.initialize(ACTOR);
			const a = new CatalogService(
				new RecordingBucket(bucket),
				noopMetrics,
				undefined,
				ZERO_BACKOFF,
			);
			const b = new CatalogService(
				new RecordingBucket(bucket),
				noopMetrics,
				undefined,
				ZERO_BACKOFF,
			);
			const stale = await a.getCurrentSnapshot();
			expect(await a.getCurrentSnapshot()).toBe(stale);
			const first = makeSnapshotProjectEntry({ name: 'From B' });
			const committed = await b.mutateSnapshot('test', ACTOR, (snapshot) => ({
				...snapshot,
				projects: [first],
			}));
			const observed = await a.getCurrentSnapshot();
			expect(observed).not.toBe(committed);
			expect(observed).toEqual(committed);
			expect(stale.projects).toEqual([]);
			const second = makeSnapshotProjectEntry({ name: 'From A' });
			await a.mutateSnapshot('test', ACTOR, (snapshot) => {
				snapshot.projects.push(second);
				return snapshot;
			});
			expect((await b.getCurrentSnapshot()).projects.map((project) => project.id)).toEqual([
				first.id,
				second.id,
			]);
		});

		it('clones in-place mutators and warms the committed snapshot', async () => {
			await catalog.initialize(ACTOR);
			const before = await catalog.getCurrentSnapshot();
			const project = makeSnapshotProjectEntry();
			const after = await catalog.mutateSnapshot('test', ACTOR, (snapshot) => {
				snapshot.projects.push(project);
				return snapshot;
			});
			expect(before.projects).toEqual([]);
			expect(after.projects).toEqual([project]);
			expect(() => before.projects.push(project)).toThrow(TypeError);
			const get = vi.spyOn(bucket, 'get');
			expect(await catalog.getCurrentSnapshot()).toBe(after);
			expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(
				0,
			);
			await expect(
				catalog.mutateSnapshot('test.fail', ACTOR, (snapshot) => {
					snapshot.projects[0].notebooks.push({} as never);
					throw new Error('mutation failed');
				}),
			).rejects.toThrow('mutation failed');
			expect(after.projects[0].notebooks).toEqual([]);
		});

		it.each(['read', 'commit', 'noop'] as const)(
			'protects snapshots and indexes exposed by %s in production',
			async (source) => {
				vi.stubEnv('NODE_ENV', 'production');
				try {
					await catalog.initialize(ACTOR);
					const project = makeSnapshotProjectEntry({ name: 'Stored' });
					const committed = await catalog.mutateSnapshot('test', ACTOR, (snapshot) => ({
						...snapshot,
						projects: [project],
					}));
					const entry = await catalog.getCurrentSnapshotEntry();
					const subject = { id: project.owner, email: 'owner@example.com' };
					expect(entry.candidatesFor(subject)).toContain(project.id);
					const exposed =
						source === 'commit'
							? committed
							: source === 'noop'
								? await catalog.mutateSnapshot('noop', ACTOR, (snapshot) => snapshot)
								: await new CatalogService(bucket).getCurrentSnapshot();
					expect(() => exposed.projects.splice(0)).toThrow(TypeError);
					expect(() => {
						exposed.projects[0].name = 'Corrupted';
					}).toThrow(TypeError);
					expect(() => {
						exposed.projects[0].owner = uid('outsider');
					}).toThrow(TypeError);
					expect(entry.byProjectId.get(project.id)?.name).toBe('Stored');
					expect(entry.candidatesFor(subject)).toContain(project.id);
					expect(await catalog.getCurrentSnapshot()).toEqual(
						await (await bucket.get(paths.snapshot(committed.snapshot_id)))!.json(),
					);
				} finally {
					vi.unstubAllEnvs();
				}
			},
		);

		it('detaches callback-owned entries before publishing in production', async () => {
			vi.stubEnv('NODE_ENV', 'production');
			try {
				await catalog.initialize(ACTOR);
				const project = makeSnapshotProjectEntry({ name: 'Stored' });
				const put = bucket.put.bind(bucket);
				vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
					const object = await put(key, value, options);
					if (key.startsWith(paths.snapshotsPrefix)) project.name = 'Changed during publication';
					return object;
				});
				const committed = await catalog.mutateSnapshot('test', ACTOR, (snapshot) => {
					snapshot.projects.push(project);
					return snapshot;
				});
				project.name = 'Changed after publication';
				const current = await catalog.getCurrentSnapshot();
				expect(current.projects[0].name).toBe('Stored');
				expect(current).toEqual(
					await (await bucket.get(paths.snapshot(committed.snapshot_id)))!.json(),
				);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('retries an in-place mutation against the winning snapshot after a CAS conflict', async () => {
			await catalog.initialize(ACTOR);
			const before = await catalog.getCurrentSnapshot();
			const competitor = makeSnapshotProjectEntry({ name: 'Competitor' });
			const own = makeSnapshotProjectEntry({ name: 'Own' });
			const put = bucket.put.bind(bucket);
			let conflict = true;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === paths.catalog && conflict) {
					conflict = false;
					await new CatalogService(bucket).mutateSnapshot('competitor', ACTOR, (snapshot) => {
						snapshot.projects.push(competitor);
						return snapshot;
					});
				}
				return put(key, value, options);
			});
			const mutate = vi.fn((snapshot: Snapshot) => {
				snapshot.projects.push(own);
				return snapshot;
			});
			const committed = await catalog.mutateSnapshot('own', ACTOR, mutate);
			expect(mutate).toHaveBeenCalledTimes(2);
			expect(before.projects).toEqual([]);
			expect(committed.projects.map((project) => project.id)).toEqual([competitor.id, own.id]);
			expect(await catalog.getCurrentSnapshot()).toEqual(committed);
		});

		it.each([false, true])(
			'reconciles a failed pointer PUT with storage (committed: %s)',
			async (committed) => {
				await catalog.initialize(ACTOR);
				const before = await catalog.getCurrentSnapshot();
				const project = makeSnapshotProjectEntry();
				const put = bucket.put.bind(bucket);
				vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
					if (key === paths.catalog) {
						if (committed) await put(key, value, options);
						throw new Error('connection lost');
					}
					return put(key, value, options);
				});
				await expect(
					catalog.mutateSnapshot('test', ACTOR, (snapshot) => {
						snapshot.projects.push(project);
						return snapshot;
					}),
				).rejects.toThrow('connection lost');
				const current = await catalog.getCurrentSnapshot();
				expect(current.projects).toEqual(committed ? [project] : []);
				expect(before.projects).toEqual([]);
				if (!committed) expect(current).toBe(before);
			},
		);

		it('does not share identical snapshot keys across buckets', async () => {
			const other = new MemoryBucket();
			const snapshot = makeSnapshot();
			for (const target of [bucket, other])
				await target.put(paths.catalog, JSON.stringify(makeCatalog(snapshot.snapshot_id)));
			await bucket.put(paths.snapshot(snapshot.snapshot_id), JSON.stringify(snapshot));
			await other.put(
				paths.snapshot(snapshot.snapshot_id),
				JSON.stringify({ ...snapshot, operation: 'other' }),
			);
			expect((await catalog.getCurrentSnapshot()).operation).toBe(snapshot.operation);
			expect((await new CatalogService(other).getCurrentSnapshot()).operation).toBe('other');
		});

		it('shares snapshots with traced service graphs and ensureInitialized', async () => {
			await catalog.initialize(ACTOR);
			const snapshot = await catalog.getCurrentSnapshot();
			const get = vi.spyOn(bucket, 'get');
			const wrapped = new RecordingBucket(bucket);
			const wrappedCatalog = new CatalogService(
				wrapped,
				noopMetrics,
				undefined,
				undefined,
				undefined,
				bucket,
			);
			expect(await wrappedCatalog.getCurrentSnapshot()).toBe(snapshot);
			expect(wrapped.calls.get).toEqual([paths.catalog]);
			for (let i = 0; i < 2; i++) {
				const services = createServices(bucket, undefined, { tracing: true });
				expect(await services.catalog.getCurrentSnapshot()).toBe(snapshot);
			}
			await ensureInitialized(bucket, ACTOR, { createDefaultProject: async () => false });
			expect(get.mock.calls.filter(([key]) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(
				0,
			);
		});

		it('fails closed on missing or unreadable pointers despite a cached snapshot', async () => {
			await catalog.initialize(ACTOR);
			await catalog.getCurrentSnapshot();
			vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('unavailable'));
			await expect(catalog.getCurrentSnapshot()).rejects.toThrow('unavailable');
			await bucket.delete(paths.catalog);
			await expect(catalog.getCurrentSnapshot()).rejects.toThrow(NotInitializedError);
		});

		it('retries a failed immutable load', async () => {
			const snapshot = await catalog.initialize(ACTOR);
			const get = bucket.get.bind(bucket);
			vi.spyOn(bucket, 'get')
				.mockImplementationOnce((key) => get(key))
				.mockRejectedValueOnce(new Error('unavailable'));
			await expect(catalog.getCurrentSnapshot()).rejects.toThrow('unavailable');
			expect(await catalog.getCurrentSnapshot()).toEqual(snapshot);
		});
	});

	describe('hasProjectInvolvement', () => {
		const outsider = { id: uid('outsider'), email: 'outsider@example.com' };

		beforeEach(async () => {
			await catalog.initialize(ACTOR);
		});

		async function seedProject(project: Project, projection: Partial<SnapshotProjectEntry> = {}) {
			await bucket.put(paths.project(project.id).meta, JSON.stringify(project));
			await catalog.mutateSnapshot('seed', ACTOR, (snapshot) => ({
				...snapshot,
				projects: [
					...snapshot.projects,
					makeSnapshotProjectEntry({
						id: project.id,
						owner: project.owner,
						status: project.status,
						member_ids: project.members.flatMap((m) => (m.user_id ? [m.user_id] : [])),
						member_emails: project.members.flatMap((m) => (m.email ? [m.email] : [])),
						member_groups: project.members.flatMap((m) => (m.group ? [m.group] : [])),
						...projection,
					}),
				],
			}));
		}

		it('shares the index across concurrent and repeated denials while refreshing the pointer', async () => {
			const get = vi.spyOn(bucket, 'get');
			expect(
				await Promise.all(Array.from({ length: 5 }, () => catalog.hasProjectInvolvement(outsider))),
			).toEqual([false, false, false, false, false]);
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
			expect(get.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(6);
			expect(get.mock.calls.filter(([key]) => key.startsWith('_system/snapshots/'))).toHaveLength(
				1,
			);
		});

		it.each(['owner', 'member_ids', 'member_emails'] as const)(
			'observes grants and authoritative revocations immediately for %s',
			async (membership) => {
				const user = { ...outsider, email: 'OUTSIDER@example.com' };
				expect(await catalog.hasProjectInvolvement(user)).toBe(false);
				const project = makeProject({
					owner: membership === 'owner' ? user.id : ACTOR,
					members:
						membership === 'owner'
							? []
							: [
									membership === 'member_ids'
										? { user_id: user.id, role: 'viewer' }
										: { email: outsider.email, role: 'viewer' },
								],
				});
				await seedProject(project);
				expect(await catalog.hasProjectInvolvement(user)).toBe(true);
				const pointer = await bucket.get(paths.catalog);
				await bucket.put(
					paths.project(project.id).meta,
					JSON.stringify({ ...project, owner: ACTOR, members: [] }),
				);
				expect(await catalog.hasProjectInvolvement(user)).toBe(false);
				expect((await bucket.get(paths.catalog))?.etag).toBe(pointer?.etag);
			},
		);

		it('loads authoritative membership when a legacy roster has no member_ids', async () => {
			const project = makeProject({ members: [{ user_id: outsider.id, role: 'viewer' }] });
			await seedProject(project, { member_ids: undefined, member_emails: undefined });
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(true);
			await bucket.put(paths.project(project.id).meta, JSON.stringify({ ...project, members: [] }));
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
		});

		it('normalizes both projected and authoritative emails and the caller email', async () => {
			await seedProject(
				makeProject({ members: [{ email: 'Outsider@Example.COM', role: 'viewer' }] }),
				{ member_emails: ['  Outsider@Example.COM '] },
			);
			expect(
				await catalog.hasProjectInvolvement({ ...outsider, email: ' OUTSIDER@EXAMPLE.com ' }),
			).toBe(true);
		});

		it.each(['deleted', 'missing'] as const)(
			'rejects a cached candidate whose authoritative project is %s',
			async (state) => {
				const project = makeProject({ owner: outsider.id });
				await seedProject(project);
				expect(await catalog.hasProjectInvolvement(outsider)).toBe(true);
				if (state === 'missing') await bucket.delete(paths.project(project.id).meta);
				else
					await bucket.put(
						paths.project(project.id).meta,
						JSON.stringify({ ...project, status: 'deleted' }),
					);
				expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
			},
		);

		it('checks each candidate only once and continues past a stale membership', async () => {
			const stale = makeProject({ members: [{ user_id: outsider.id, role: 'viewer' }] });
			const active = makeProject({
				owner: outsider.id,
				members: [
					{ user_id: outsider.id, role: 'admin' },
					{ email: outsider.email, role: 'viewer' },
				],
			});
			await seedProject(stale);
			await seedProject(active);
			await bucket.put(paths.project(stale.id).meta, JSON.stringify({ ...stale, members: [] }));
			const get = vi.spyOn(bucket, 'get');
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(true);
			expect(get.mock.calls.filter(([key]) => key === paths.project(stale.id).meta)).toHaveLength(
				1,
			);
			expect(get.mock.calls.filter(([key]) => key === paths.project(active.id).meta)).toHaveLength(
				1,
			);
		});

		it('does not load unrelated modern projects for repeated denials', async () => {
			await seedProject(makeProject());
			const get = vi.spyOn(bucket, 'get');
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
			expect(get.mock.calls.filter(([key]) => key.endsWith('/project.json'))).toHaveLength(0);
			expect(get.mock.calls.filter(([key]) => key.startsWith('_system/snapshots/'))).toHaveLength(
				0,
			);
		});

		it('validates legacy rosters on every concurrent and repeated denial', async () => {
			const project = makeProject();
			await seedProject(project, { member_ids: undefined });
			const get = vi.spyOn(bucket, 'get');
			expect(
				await Promise.all(Array.from({ length: 5 }, () => catalog.hasProjectInvolvement(outsider))),
			).toEqual([false, false, false, false, false]);
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
			expect(get.mock.calls.filter(([key]) => key === paths.project(project.id).meta)).toHaveLength(
				6,
			);
			expect(get.mock.calls.filter(([key]) => key.startsWith('_system/snapshots/'))).toHaveLength(
				0,
			);
		});

		it('fails closed on an authoritative read failure and retries the read', async () => {
			const project = makeProject({ owner: outsider.id });
			await seedProject(project);
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(true);
			const original = bucket.get.bind(bucket);
			const get = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				if (key === paths.project(project.id).meta) throw new Error('project unavailable');
				return original(key);
			});
			await expect(catalog.hasProjectInvolvement(outsider)).rejects.toThrow('project unavailable');
			get.mockRestore();
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(true);
		});

		it('excludes deleted projects', async () => {
			await catalog.mutateSnapshot('delete', ACTOR, (snapshot) => ({
				...snapshot,
				projects: [makeSnapshotProjectEntry({ owner: outsider.id, status: 'deleted' })],
			}));
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
		});

		it('retries an index load after a transient snapshot failure', async () => {
			const original = bucket.get.bind(bucket);
			const get = vi
				.spyOn(bucket, 'get')
				.mockImplementationOnce(original)
				.mockRejectedValueOnce(new Error('storage failed'));
			await expect(catalog.hasProjectInvolvement(outsider)).rejects.toThrow('storage failed');
			get.mockRestore();
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(false);
		});

		it('fails closed if the current pointer disappears after caching a grant', async () => {
			await seedProject(makeProject({ owner: outsider.id }));
			expect(await catalog.hasProjectInvolvement(outsider)).toBe(true);
			await bucket.delete(paths.catalog);
			await expect(catalog.hasProjectInvolvement(outsider)).rejects.toThrow(NotInitializedError);
		});
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
			await catalog.mutateSnapshot('test', ACTOR, (s) => ({ ...s }));

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

			const result = await catalog.mutateSnapshot('test', ACTOR, (s) => ({ ...s }));
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

			await expect(catalog.mutateSnapshot('test', ACTOR, (s) => ({ ...s }))).rejects.toThrow(
				ConflictError,
			);
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

			await catalog.mutateSnapshot('test', ACTOR, (s) => ({ ...s }));

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

			await expect(svc.mutateSnapshot('test', ACTOR, (s) => ({ ...s }))).rejects.toThrow(
				'snapshot put boom',
			);

			expect(increment).not.toHaveBeenCalled();
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

			expect(increment).not.toHaveBeenCalled();
			expect((await bucket.list({ prefix: paths.snapshotsPrefix })).objects.length).toBe(before);
		});

		it('throws NotInitializedError without retrying when the snapshot pointer dangles', async () => {
			const increment = vi.fn();
			const svc = new CatalogService(bucket, { increment, gauge: vi.fn() });
			const missing = createSnapshotId();
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(missing)));

			await expect(svc.mutateSnapshot('test', ACTOR, (s) => ({ ...s }))).rejects.toBeInstanceOf(
				NotInitializedError,
			);
			expect(increment).not.toHaveBeenCalled();
		});

		it('throws a corrupted-object error on malformed catalog JSON', async () => {
			await bucket.put(paths.catalog, JSON.stringify({ not: 'a catalog' }));
			await expect(catalog.mutateSnapshot('test', ACTOR, (s) => ({ ...s }))).rejects.toThrow(
				/Stored data is temporarily unavailable/,
			);
		});

		it('throws a corrupted-object error on a malformed snapshot object', async () => {
			const corrupt = createSnapshotId();
			await bucket.put(paths.snapshot(corrupt), JSON.stringify({ nope: true }));
			await bucket.put(paths.catalog, JSON.stringify(makeCatalog(corrupt)));
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

			const result = await catalog.mutateSnapshot('test.op', ACTOR, (s) => ({ ...s }));

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
		it('does not count reads, cache validation, or no-op mutations as writes', async () => {
			const increment = vi.fn();
			const instrumented = new CatalogService(bucket, { increment, gauge: vi.fn() });
			await instrumented.initialize(ACTOR);
			const put = vi.spyOn(bucket, 'put');

			await instrumented.getCurrentSnapshot();
			await instrumented.getCurrentSnapshot();
			await instrumented.mutateSnapshot('noop', ACTOR, (snapshot) => snapshot);

			expect(put).not.toHaveBeenCalled();
			expect(increment).not.toHaveBeenCalled();
		});

		it('counts each conditional write and only the rejected write as a conflict', async () => {
			const increment = vi.fn();
			const instrumented = new CatalogService(
				bucket,
				{ increment, gauge: vi.fn() },
				undefined,
				ZERO_BACKOFF,
			);
			await instrumented.initialize(ACTOR);
			const originalPut = bucket.put.bind(bucket);
			let writes = 0;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === paths.catalog && ++writes === 1) {
					throw new PreconditionFailedError('competing write');
				}
				return originalPut(key, value, options);
			});

			await instrumented.mutateSnapshot('test', ACTOR, (snapshot) => ({ ...snapshot }));

			expect(writes).toBe(2);
			expect(increment.mock.calls).toEqual([
				['catalog.cas.attempt'],
				['catalog.cas.conflict'],
				['catalog.cas.attempt'],
			]);
		});

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

			await expect(instrumented.mutateSnapshot('t', ACTOR, (s) => ({ ...s }))).rejects.toThrow(
				ConflictError,
			);
			expect(increment.mock.calls).toEqual([
				...Array.from({ length: 5 }, () => [
					['catalog.cas.attempt'],
					['catalog.cas.conflict'],
				]).flat(),
				['catalog.cas.exhausted'],
			]);
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
			await audited.mutateSnapshot('project.update', ACTOR, (s) => ({ ...s }), {
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

			await audited.mutateSnapshot('project.update', ACTOR, (s) => ({ ...s }));

			expect(callCount).toBe(1); // the race actually happened
			expect(await listEvents()).toHaveLength(1);
		});

		it('a failing append does not fail the mutation and bumps events.append_failed', async () => {
			const increment = vi.fn();
			const flaky = new CatalogService(bucket, { increment, gauge: vi.fn() }, events);
			vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('events boom'));

			const result = await flaky.mutateSnapshot('project.update', ACTOR, (s) => ({ ...s }));

			expect(result.operation).toBe('project.update');
			expect(increment).toHaveBeenCalledWith('events.append_failed');
			expect(await listEvents()).toHaveLength(0);
		});

		it('commits and audits nothing when the mutator returns its input', async () => {
			const before = await audited.getCurrentSnapshot();
			const pointer = await bucket.head(paths.catalog);
			const put = vi.spyOn(bucket, 'put');

			const result = await audited.mutateSnapshot('project.update', ACTOR, (s) => s);
			await audited.updateProjectEntry('project.update', ACTOR, createProjectId(), () => ({
				name: 'Missing',
			}));

			expect(result).toEqual(before);
			expect(put).not.toHaveBeenCalled();
			expect((await bucket.head(paths.catalog))?.etag).toBe(pointer?.etag);
			expect(await listEvents()).toHaveLength(0);
		});

		it('writes one snapshot, one pointer swap, and one event for a real change', async () => {
			const put = vi.spyOn(bucket, 'put');

			await audited.mutateSnapshot('project.create', ACTOR, (s) => ({
				...s,
				projects: [...s.projects, makeSnapshotProjectEntry()],
			}));

			const keys = put.mock.calls.map(([key]) => key);
			expect(keys.filter((key) => key === paths.catalog)).toHaveLength(1);
			expect(keys.filter((key) => key.startsWith(paths.snapshotsPrefix))).toHaveLength(1);
			expect(await listEvents()).toHaveLength(1);
		});

		it('retries a lost race and skips the commit once the retry finds the change applied', async () => {
			const entry = makeSnapshotProjectEntry();
			const addEntry = (s: Snapshot): Snapshot =>
				s.projects.some((p) => p.id === entry.id) ? s : { ...s, projects: [...s.projects, entry] };
			const rival = new CatalogService(bucket, noopMetrics);
			const snapshotPuts: string[] = [];
			let raced = false;
			const originalPut = bucket.put.bind(bucket);
			bucket.put = async (key, value, opts) => {
				if (key.startsWith(paths.snapshotsPrefix)) snapshotPuts.push(key);
				if (key === paths.catalog && opts?.onlyIfEtagMatches && !raced) {
					raced = true;
					await rival.mutateSnapshot('project.create', ACTOR, addEntry);
				}
				return originalPut(key, value, opts);
			};

			const result = await audited.mutateSnapshot('project.create', ACTOR, addEntry);

			expect(raced).toBe(true);
			expect(result.projects.filter((p) => p.id === entry.id)).toHaveLength(1);
			// Ours lost the CAS and was removed; only the rival's snapshot remains.
			expect(snapshotPuts).toHaveLength(2);
			expect(await bucket.get(snapshotPuts[0])).toBeNull();
			expect(result.snapshot_id).toBe((await rival.getCurrentSnapshot()).snapshot_id);
			expect(await listEvents()).toHaveLength(0);
		});

		it('writes no events when no EventService is injected', async () => {
			await catalog.mutateSnapshot('project.update', ACTOR, (s) => ({ ...s }));
			expect(await listEvents()).toHaveLength(0);
		});
	});

	describe('updateNotebookEntry', () => {
		async function setupEntry() {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'D' }, ACTOR);
			const notebook = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'D', code: 'print(1)' },
				ACTOR,
			);
			return { env, project, notebook };
		}

		it('preserves the mutation ID and writes no snapshot or audit for equal projection patches', async () => {
			const { env, project, notebook } = await setupEntry();
			const before = await env.catalog.getCurrentSnapshot();
			const put = vi.spyOn(env.bucket, 'put');
			const projectResult = await env.catalog.updateProjectEntry(
				'project.update',
				ACTOR,
				project.id,
				(entry) => ({
					name: entry.name,
					tags: entry.tags && [...entry.tags],
					security_labels: entry.security_labels,
				}),
			);
			const notebookResult = await env.catalog.updateNotebookEntry(
				'notebook.update',
				ACTOR,
				project.id,
				notebook.id,
				(entry) => ({
					title: entry.title,
					tags: entry.tags && [...entry.tags],
					updated_at: entry.updated_at,
				}),
			);
			const missingResult = await env.catalog.updateNotebookEntry(
				'notebook.update',
				ACTOR,
				project.id,
				createNotebookId(),
				vi.fn(),
			);
			const undefinedResult = await env.catalog.updateProjectEntry(
				'project.update',
				ACTOR,
				project.id,
				vi.fn(),
			);
			for (const result of [projectResult, notebookResult, missingResult, undefinedResult])
				expect(result.snapshot_id).toBe(before.snapshot_id);
			expect(put).not.toHaveBeenCalled();
		});

		it('turns a losing update into a no-op when the winner already applied the same patch', async () => {
			const { env, project, notebook } = await setupEntry();
			const events = new EventService(env.bucket);
			const append = vi.spyOn(events, 'append');
			const service = new CatalogService(env.bucket, noopMetrics, events, ZERO_BACKOFF);
			const realPut = env.bucket.put.bind(env.bucket);
			let winningSnapshot: Snapshot | undefined;
			let race = true;
			const put = vi.spyOn(env.bucket, 'put').mockImplementation(async (key, value, options) => {
				if (key === paths.catalog && race) {
					race = false;
					winningSnapshot = await env.catalog.updateNotebookEntry(
						'winner',
						ACTOR,
						project.id,
						notebook.id,
						() => ({ title: 'Renamed' }),
					);
				}
				return realPut(key, value, options);
			});
			const patch = vi.fn().mockReturnValue({ title: 'Renamed' });
			const result = await service.updateNotebookEntry(
				'loser',
				ACTOR,
				project.id,
				notebook.id,
				patch,
			);
			expect(patch).toHaveBeenCalledTimes(2);
			expect(result.snapshot_id).toBe(winningSnapshot!.snapshot_id);
			expect(put.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(2);
			expect(append).not.toHaveBeenCalled();
		});

		it('leaves the catalog intact when an asynchronous projection fails', async () => {
			const { env, project, notebook } = await setupEntry();
			const before = await env.catalog.getCurrentSnapshot();
			const put = vi.spyOn(env.bucket, 'put');
			await expect(
				env.catalog.updateNotebookEntry(
					'notebook.update',
					ACTOR,
					project.id,
					notebook.id,
					async () => {
						throw new Error('metadata unavailable');
					},
				),
			).rejects.toThrow('metadata unavailable');
			expect(put).not.toHaveBeenCalled();
			expect((await env.catalog.getCurrentSnapshot()).snapshot_id).toBe(before.snapshot_id);
		});

		it('commits clearing a projected field and returns a new mutation ID', async () => {
			const { env, project, notebook } = await setupEntry();
			const before = await env.catalog.updateNotebookEntry(
				'notebook.update',
				ACTOR,
				project.id,
				notebook.id,
				() => ({ security_labels_pending: true }),
			);
			const put = vi.spyOn(env.bucket, 'put');
			const result = await env.catalog.updateNotebookEntry(
				'notebook.update',
				ACTOR,
				project.id,
				notebook.id,
				() => ({ security_labels_pending: undefined }),
			);
			expect(result.snapshot_id).not.toBe(before.snapshot_id);
			expect(result.projects[0].notebooks[0].security_labels_pending).toBeUndefined();
			expect(put.mock.calls.filter(([key]) => key === paths.catalog)).toHaveLength(1);
		});

		it.each([
			{
				name: 'keeps a newer notebook timestamp over an older project patch',
				notebookAt: '2099-01-01T00:00:00.000Z',
				projectAt: '2000-01-01T00:00:00.000Z',
				expected: '2099-01-01T00:00:00.000Z',
			},
			{
				name: 'uses a newer explicit project timestamp',
				notebookAt: '2099-01-01T00:00:00.000Z',
				projectAt: '2100-01-01T00:00:00.000Z',
				expected: '2100-01-01T00:00:00.000Z',
			},
		])('$name', async ({ notebookAt, projectAt, expected }) => {
			const { env, project, notebook } = await setupEntry();

			const snapshot = await env.catalog.updateNotebookEntry(
				'test.notebook.patch',
				ACTOR,
				project.id,
				notebook.id,
				() => ({ updated_at: notebookAt }),
				() => ({ updated_at: projectAt }),
			);

			expect(snapshot.projects[0].notebooks[0].updated_at).toBe(notebookAt);
			expect(snapshot.projects[0].updated_at).toBe(expected);
		});

		it('skips the notebook patch when the entry is missing', async () => {
			const { env, project } = await setupEntry();
			const before = await env.catalog.getCurrentSnapshot();
			const notebookPatch = vi.fn();
			const projectPatch = vi.fn().mockReturnValue({
				updated_at: '2000-01-01T00:00:00.000Z',
				notebook_count: 7,
			});

			const snapshot = await env.catalog.updateNotebookEntry(
				'test.notebook.missing',
				ACTOR,
				project.id,
				createNotebookId(),
				notebookPatch,
				projectPatch,
			);

			expect(notebookPatch).not.toHaveBeenCalled();
			expect(projectPatch).toHaveBeenCalledOnce();
			expect(snapshot.projects[0].notebooks).toEqual(before.projects[0].notebooks);
			expect(snapshot.projects[0].updated_at).toBe(before.projects[0].updated_at);
			expect(snapshot.projects[0].notebook_count).toBe(7);
		});
	});

	describe('appendNotebookEntry ifAbsent', () => {
		it('returns the current snapshot without committing when the entry exists', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'D' }, ACTOR);
			const notebook = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'D', code: 'print(1)' },
				ACTOR,
			);
			const before = await env.catalog.getCurrentSnapshot();
			const entry = before.projects[0].notebooks[0];

			const snapshot = await env.catalog.appendNotebookEntry(
				'test.append',
				ACTOR,
				project.id,
				entry,
				{
					ifAbsent: true,
				},
			);

			expect(snapshot.snapshot_id).toBe(before.snapshot_id);
			expect((await env.catalog.getCurrentSnapshot()).snapshot_id).toBe(before.snapshot_id);
			expect(snapshot.projects[0].notebooks.map((n) => n.id)).toEqual([notebook.id]);
		});

		it('rejects a missing project instead of skipping it', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'D' }, ACTOR);
			await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'D', code: 'print(1)' },
				ACTOR,
			);
			const entry = (await env.catalog.getCurrentSnapshot()).projects[0].notebooks[0];
			await expect(
				env.catalog.appendNotebookEntry(
					'test.append',
					ACTOR,
					'proj-0000000000000000' as typeof project.id,
					entry,
					{ ifAbsent: true },
				),
			).rejects.toBeInstanceOf(NotFoundError);
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
