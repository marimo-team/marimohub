import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot, makeSnapshotProjectEntry, MemoryBucket, uid } from '../../testing';
import { confirmAccessSummaries, projectedRole, snapshotCache } from './snapshotCache';

afterEach(() => vi.restoreAllMocks());

it('counts cold, concurrent, warm, failed, and evicted snapshot loads', async () => {
	const metrics = { increment: vi.fn(), gauge: vi.fn() };
	const cache = snapshotCache(new MemoryBucket());
	const load = vi.fn(async () => makeSnapshot());
	const first = cache.read('a', load, metrics);
	const concurrent = cache.read('a', load, metrics);
	await Promise.all([first, concurrent]);
	await cache.read('a', load, metrics);
	expect(load).toHaveBeenCalledOnce();
	await cache.read('b', load, metrics);
	await cache.read('c', load, metrics);
	await cache.read('a', load, metrics);
	await expect(
		cache.read(
			'failed',
			async () => {
				throw new Error('unavailable');
			},
			metrics,
		),
	).rejects.toThrow('unavailable');
	await cache.read('failed', load, metrics);
	expect(metrics.increment.mock.calls.map(([, , tags]) => tags.result)).toEqual([
		'miss',
		'hit',
		'hit',
		'miss',
		'miss',
		'miss',
		'miss',
		'miss',
	]);
});

it('shares a failed load, then permits one fresh load and caches its result', async () => {
	const cache = snapshotCache(new MemoryBucket());
	const gate = Promise.withResolvers<ReturnType<typeof makeSnapshot>>();
	const load = vi.fn(() => gate.promise);
	const first = cache.read('snapshot', load);
	const second = cache.read('snapshot', load);
	const failure = new Error('storage unavailable');
	const settled = Promise.allSettled([first, second]);
	gate.reject(failure);
	expect(await settled).toEqual([
		{ status: 'rejected', reason: failure },
		{ status: 'rejected', reason: failure },
	]);
	expect(load).toHaveBeenCalledOnce();
	const snapshot = makeSnapshot();
	const retry = vi.fn(async () => snapshot);
	const [recovered, concurrent] = await Promise.all([
		cache.read('snapshot', retry),
		cache.read('snapshot', retry),
	]);
	expect(recovered.snapshot).toBe(snapshot);
	expect(concurrent).toBe(recovered);
	expect(await cache.read('snapshot', retry)).toBe(recovered);
	expect(retry).toHaveBeenCalledOnce();
});

describe('projectedRole', () => {
	const member = { id: uid('member'), email: 'Member@Example.com' };
	const updated_at = '2026-11-01T00:00:00.000Z';
	const later = '2026-11-01T00:00:00.001Z';
	const trusted = makeSnapshotProjectEntry({
		updated_at,
		default_role: 'none',
		member_ids: [member.id],
		member_emails: ['invitee@example.com'],
		member_groups: ['analysts'],
		access: {
			members: [
				{ user_id: member.id, role: 'editor' },
				{ email: 'INVITEE@example.com', role: 'viewer' },
				{ group: 'analysts', role: 'viewer' },
			],
			default_role: 'none',
			version: 1,
			entry_updated_at: updated_at,
		},
	});

	it('trusts a summary consistent with the candidate fields', () => {
		expect(projectedRole(trusted, member)).toBe('editor');
	});

	// A v0.6.4 writer rewrites the candidate fields and default_role but keeps `access`.
	it.each([
		['a removed member', { member_ids: [] }],
		['an added invite', { member_emails: ['invitee@example.com', 'new@example.com'] }],
		['a removed group', { member_groups: [] }],
		['a default-role change', { default_role: 'viewer' as const }],
		['a role-only member edit', { updated_at: later }],
	])('falls back to metadata after a legacy writer applies %s', (_, patch) => {
		expect(projectedRole({ ...trusted, ...patch }, member)).toBeUndefined();
	});

	it('does not trust a summary without a confirmation marker', () => {
		const { entry_updated_at: _, ...access } = trusted.access!;
		expect(projectedRole({ ...trusted, access }, member)).toBeUndefined();
	});

	it('re-confirms a trusted summary that a write preserved while advancing updated_at', () => {
		const next = confirmAccessSummaries(
			makeSnapshot({ projects: [trusted] }),
			makeSnapshot({ projects: [{ ...trusted, updated_at: later }] }),
		);
		expect(next.projects[0].access?.entry_updated_at).toBe(later);
		expect(projectedRole(next.projects[0], member)).toBe('editor');
	});

	it('never re-confirms a summary a legacy writer left stale', () => {
		const legacy = { ...trusted, updated_at: later };
		const resaved = { ...legacy, updated_at: '2026-11-01T00:00:01.000Z' };
		const next = confirmAccessSummaries(
			makeSnapshot({ projects: [legacy] }),
			makeSnapshot({ projects: [resaved] }),
		);
		expect(next.projects[0]).toBe(resaved);
		expect(projectedRole(next.projects[0], member)).toBeUndefined();
	});

	it('confirms a summary this write projected', () => {
		const legacy = { ...trusted, updated_at: later };
		const projected = {
			...legacy,
			updated_at: '2026-11-01T00:00:01.000Z',
			access: { ...legacy.access!, entry_updated_at: later },
		};
		const next = confirmAccessSummaries(
			makeSnapshot({ projects: [legacy] }),
			makeSnapshot({ projects: [projected] }),
		);
		expect(projectedRole(next.projects[0], member)).toBe('editor');
	});
});
