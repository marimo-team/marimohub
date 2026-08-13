import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictError, NotFoundError, PreconditionFailedError } from '../../errors';
import { UserId } from '../../ids';
import type { ProjectId } from '../../ids';
import { paths } from '../../paths';
import { ACTOR, setupTestEnv } from '../../testing';
import type { MemoryBucket } from '../../testing';
import type { CatalogService } from '../catalog/CatalogService';
import type { NotebookService } from './NotebookService';
import type { ProjectService } from './ProjectService';
import { listAllKeys } from '../catalog/storage';

describe('ProjectService', () => {
	let bucket: MemoryBucket;
	let projects: ProjectService;
	let notebooks: NotebookService;
	let catalog: CatalogService;

	beforeEach(async () => {
		const env = await setupTestEnv();
		bucket = env.bucket;
		projects = env.projects;
		notebooks = env.notebooks;
		catalog = env.catalog;
	});

	describe('createProject', () => {
		it('strips control characters from names and rejects control-only names', async () => {
			await expect(
				projects.createProject({ name: 'Forecasts\n\u0000Prod', description: 'D' }, ACTOR),
			).resolves.toMatchObject({ name: 'ForecastsProd' });
			await expect(
				projects.createProject({ name: '\n\u0000\u007f', description: 'D' }, ACTOR),
			).rejects.toThrow(/visible character/);
		});

		it('creates a project and adds it to the snapshot', async () => {
			const project = await projects.createProject(
				{ name: 'ML Pipeline', description: 'ML notebooks' },
				ACTOR,
			);

			expect(project.name).toBe('ML Pipeline');
			expect(project.owner).toBe(ACTOR);
			expect(project.members).toEqual([{ user_id: ACTOR, role: 'admin' }]);

			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects).toHaveLength(1);
			expect(snap.projects[0].name).toBe('ML Pipeline');
			expect(snap.projects[0].notebook_count).toBe(0);
			// The owner is seeded into the denormalized roster on the snapshot entry.
			expect(snap.projects[0].member_ids).toEqual([ACTOR]);
		});

		it('uses provided tags', async () => {
			const project = await projects.createProject(
				{ name: 'P', description: 'D', tags: ['a', 'b'] },
				ACTOR,
			);
			expect(project.tags).toEqual(['a', 'b']);
		});

		it('defaults tags to empty array', async () => {
			const project = await projects.createProject({ name: 'P', description: 'D' }, ACTOR);
			expect(project.tags).toEqual([]);
		});

		it('rolls back the project blob when the catalog write fails', async () => {
			const before = (await listAllKeys(bucket, '')).sort();
			vi.spyOn(catalog, 'mutateSnapshot').mockRejectedValueOnce(new Error('catalog boom'));

			await expect(
				projects.createProject({ name: 'Doomed', description: 'fail' }, ACTOR),
			).rejects.toThrow('catalog boom');

			// Saga compensation deleted the orphaned project blob: no new keys remain.
			const after = (await listAllKeys(bucket, '')).sort();
			expect(after).toEqual(before);
		});
	});

	describe('getProject', () => {
		it('returns the project by id', async () => {
			const created = await projects.createProject({ name: 'Test', description: 'D' }, ACTOR);
			const fetched = await projects.getProject(created.id);
			expect(fetched.id).toBe(created.id);
			expect(fetched.name).toBe('Test');
		});

		it('throws NotFoundError for missing project', async () => {
			await expect(
				projects.getProject('proj_01HXY00000000000000000000' as ProjectId),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('listProjects', () => {
		it('returns empty list initially', async () => {
			const list = await projects.listProjects();
			expect(list).toEqual([]);
		});

		it('returns all created projects', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.createProject({ name: 'B', description: 'b' }, ACTOR);

			const list = await projects.listProjects();
			expect(list).toHaveLength(2);
			expect(list.map((p) => p.name).sort()).toEqual(['A', 'B']);
		});

		it('never exposes member_ids on the public entry', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			const [entry] = await projects.listProjects();
			expect(entry).not.toHaveProperty('member_ids');
		});
	});

	describe('listProjects visibility filter (MARIMOHUB_DEFAULT_ROLE=none)', () => {
		const STRANGER = { id: UserId.parse('user_stranger'), email: 'stranger@example.com' };
		const OWNER = { id: ACTOR, email: 'actor@example.com' };

		it('returns all projects when a default role is set', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			const list = await projects.listProjects({
				subject: STRANGER,
				policy: { defaultRole: 'viewer' },
			});
			expect(list.map((p) => p.name)).toEqual(['A']);
		});

		it('returns all projects when the caller has a default-role entitlement', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			const list = await projects.listProjects({
				subject: { ...STRANGER, entitlements: ['default-role:viewer'] },
			});
			expect(list.map((p) => p.name)).toEqual(['A']);
		});

		it('hides projects a caller does not own or belong to when defaultRole is null', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			// Owner sees it; a stranger does not.
			expect(await projects.listProjects({ subject: OWNER })).toHaveLength(1);
			expect(await projects.listProjects({ subject: STRANGER })).toEqual([]);
		});

		it('shows a project once the caller is added as a member', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { user_id: STRANGER.id }, 'viewer', ACTOR);
			const list = await projects.listProjects({ subject: STRANGER });
			expect(list.map((e) => e.id)).toEqual([p.id]);
		});

		it('shows a project to an email member via the denormalized roster', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { email: STRANGER.email }, 'viewer', ACTOR);
			const list = await projects.listProjects({ subject: STRANGER });
			expect(list.map((e) => e.id)).toEqual([p.id]);
		});

		it('falls back to project.json when the snapshot entry predates member_ids', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { user_id: STRANGER.id }, 'viewer', ACTOR);
			// Simulate an old snapshot entry: strip the denormalized roster.
			await catalog.updateProjectEntry('test.strip', ACTOR, p.id, () => ({
				member_ids: undefined,
			}));
			expect((await catalog.getCurrentSnapshot()).projects[0].member_ids).toBeUndefined();

			// The member is still visible via the project.json fallback.
			const list = await projects.listProjects({ subject: STRANGER });
			expect(list.map((e) => e.id)).toEqual([p.id]);
		});

		it('hides the project from a stranger via the project.json deny fallback', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			// Simulate an old snapshot entry (no denormalized roster) so visibility is
			// indeterminate from the snapshot and must fall back to project.json.
			await catalog.updateProjectEntry('test.strip', ACTOR, p.id, () => ({
				member_ids: undefined,
			}));
			expect((await catalog.getCurrentSnapshot()).projects[0].member_ids).toBeUndefined();

			// The stranger is neither owner nor a member, so the deny branch of
			// canSeeProject hides the project entirely.
			const list = await projects.listProjects({ subject: STRANGER });
			expect(list).toEqual([]);
		});

		it('shows every project to a super admin, including legacy entries', async () => {
			const a = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.createProject({ name: 'B', description: 'b' }, ACTOR);
			// A legacy entry (no denormalized roster) must not trip the
			// project.json fallback for a super admin — the fast path covers it.
			await catalog.updateProjectEntry('test.strip', ACTOR, a.id, () => ({
				member_ids: undefined,
			}));

			const policy = { superAdmins: [STRANGER.email] };
			const list = await projects.listProjects({ subject: STRANGER, policy });
			expect(list.map((p) => p.name).sort()).toEqual(['A', 'B']);
		});

		it('does not open god-mode listing on an id/email namespace collision', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			// An email entry whose value equals the caller's ID must not elevate:
			// the caller's real email is their own, so the fast path stays closed.
			const impostor = { id: UserId.parse('admin@example.com'), email: 'attacker@evil.example' };
			const list = await projects.listProjects({
				subject: impostor,
				policy: { superAdmins: ['admin@example.com'] },
			});
			expect(list).toEqual([]);
		});
	});

	describe('membership', () => {
		const MEMBER = UserId.parse('user_member');

		it('projects the latest roster when catalog updates finish out of order', async () => {
			const project = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			const first = UserId.parse('first_member');
			const second = UserId.parse('second_member');
			const realUpdateEntry = catalog.updateProjectEntry.bind(catalog);
			let raced = false;
			vi.spyOn(catalog, 'updateProjectEntry').mockImplementation(async (...args) => {
				if (!raced && args[0] === 'project.members') {
					raced = true;
					await projects.addMember(project.id, { user_id: second }, 'viewer', ACTOR);
				}
				return realUpdateEntry(...args);
			});

			await projects.addMember(project.id, { user_id: first }, 'editor', ACTOR);

			const stored = await projects.getProject(project.id);
			const snapshot = await catalog.getCurrentSnapshot();
			expect(stored.members).toEqual([
				{ user_id: ACTOR, role: 'admin' },
				{ user_id: first, role: 'editor' },
				{ user_id: second, role: 'viewer' },
			]);
			expect(snapshot.projects[0].member_ids).toEqual([ACTOR, first, second]);
		});

		it('detects a duplicate member added by a concurrent writer', async () => {
			const project = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			const metaKey = paths.project(project.id).meta;
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (!raced && key === metaKey && options?.onlyIfEtagMatches) {
					raced = true;
					await projects.addMember(project.id, { email: 'racer@example.com' }, 'viewer', ACTOR);
				}
				return realPut(key, value, options);
			});

			await expect(
				projects.addMember(project.id, { email: 'racer@example.com' }, 'editor', ACTOR),
			).rejects.toBeInstanceOf(ConflictError);

			const stored = await projects.getProject(project.id);
			expect(stored.members.filter((member) => member.email === 'racer@example.com')).toHaveLength(
				1,
			);
		});

		it('adds a member by user id and denormalizes member_ids', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { user_id: MEMBER }, 'editor', ACTOR);

			const stored = await projects.getProject(p.id);
			expect(stored.members).toContainEqual({ user_id: MEMBER, role: 'editor' });
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects[0].member_ids).toEqual([ACTOR, MEMBER]);
			expect(snap.projects[0].member_emails).toEqual([]);
		});

		it('adds an email member lowercased and denormalizes member_emails', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			const mutation = await projects.addMemberWithMutation(
				p.id,
				{ email: 'Invitee@Example.COM' },
				'viewer',
				ACTOR,
			);

			const stored = await projects.getProject(p.id);
			expect(stored.members).toContainEqual({ email: 'invitee@example.com', role: 'viewer' });
			const snap = await catalog.getCurrentSnapshot();
			expect(mutation).toMatchObject({ project: stored, mutationId: snap.snapshot_id });
			expect(snap.projects[0].member_emails).toEqual(['invitee@example.com']);
		});

		it('rejects an id add carrying an email that matches a pending invite (409)', async () => {
			// One person must never hold both an invite row and an id row — removing
			// one would silently leave the other granting access.
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { email: 'alice@x.io' }, 'editor', ACTOR);

			await expect(
				projects.addMember(p.id, { user_id: MEMBER, email: 'Alice@X.io' }, 'viewer', ACTOR),
			).rejects.toThrow(/already a member/);
		});

		it('rejects a duplicate member (409) by id and by email regardless of case', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { user_id: MEMBER }, 'editor', ACTOR);
			await projects.addMember(p.id, { email: 'dup@example.com' }, 'viewer', ACTOR);

			await expect(projects.addMember(p.id, { user_id: MEMBER }, 'viewer', ACTOR)).rejects.toThrow(
				/already a member/,
			);
			await expect(
				projects.addMember(p.id, { email: 'DUP@example.com' }, 'editor', ACTOR),
			).rejects.toThrow(/already a member/);
		});

		it('updates and removes a member by email selector', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { email: 'invitee@example.com' }, 'viewer', ACTOR);

			const updated = await projects.updateMemberRole(p.id, 'Invitee@example.com', 'editor', ACTOR);
			expect(updated.members).toContainEqual({ email: 'invitee@example.com', role: 'editor' });

			const removed = await projects.removeMember(p.id, 'invitee@example.com', ACTOR);
			expect(removed.members.some((m) => m.email === 'invitee@example.com')).toBe(false);
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects[0].member_emails).toEqual([]);
		});

		it('404s when updating or removing a non-member', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await expect(projects.updateMemberRole(p.id, MEMBER, 'editor', ACTOR)).rejects.toThrow(
				NotFoundError,
			);
			await expect(projects.removeMember(p.id, 'ghost@example.com', ACTOR)).rejects.toThrow(
				NotFoundError,
			);
		});

		it('protects the owner from role change and removal', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await expect(projects.updateMemberRole(p.id, ACTOR, 'viewer', ACTOR)).rejects.toThrow(
				/owner/,
			);
			await expect(projects.removeMember(p.id, ACTOR, ACTOR)).rejects.toThrow(/owner/);
		});
	});

	describe('updateProject', () => {
		it('strips control characters from replacement names', async () => {
			const created = await projects.createProject({ name: 'Original', description: 'D' }, ACTOR);
			await expect(
				projects.updateProject(created.id, { name: 'Safe\r\nName' }, ACTOR),
			).resolves.toMatchObject({ name: 'SafeName' });
		});

		it('uses the CAS read as the authoritative precondition check', async () => {
			const created = await projects.createProject({ name: 'Original', description: 'D' }, ACTOR);
			const metaKey = paths.project(created.id).meta;
			const realGet = bucket.get.bind(bucket);
			const realPut = bucket.put.bind(bucket);
			let metaCommitted = false;
			let readsBeforeCommit = 0;
			vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
				if (key === metaKey && !metaCommitted) readsBeforeCommit++;
				return realGet(key);
			});
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				const result = await realPut(key, value, options);
				if (key === metaKey && options?.onlyIfEtagMatches) metaCommitted = true;
				return result;
			});

			await projects.updateProject(created.id, { name: 'Updated' }, ACTOR, created.updated_at);

			expect(readsBeforeCommit).toBe(1);
		});

		it('projects the latest metadata when catalog updates finish out of order', async () => {
			const created = await projects.createProject({ name: 'Original', description: 'D' }, ACTOR);
			const realUpdateEntry = catalog.updateProjectEntry.bind(catalog);
			let raced = false;
			vi.spyOn(catalog, 'updateProjectEntry').mockImplementation(async (...args) => {
				if (!raced && args[0] === 'project.update') {
					raced = true;
					await projects.updateProject(created.id, { name: 'Winner' }, ACTOR);
				}
				return realUpdateEntry(...args);
			});

			await projects.updateProject(created.id, { name: 'Delayed' }, ACTOR);

			const stored = await projects.getProject(created.id);
			const snapshot = await catalog.getCurrentSnapshot();
			expect(raced).toBe(true);
			expect(stored.name).toBe('Winner');
			expect(snapshot.projects[0].name).toBe('Winner');
		});

		it('does not fail or resurrect a project purged after its metadata commit', async () => {
			const created = await projects.createProject({ name: 'Original', description: 'D' }, ACTOR);
			const realUpdateEntry = catalog.updateProjectEntry.bind(catalog);
			let purged = false;
			vi.spyOn(catalog, 'updateProjectEntry').mockImplementation(async (...args) => {
				if (!purged && args[0] === 'project.update') {
					purged = true;
					await projects.deleteProject(created.id, ACTOR);
					await projects.hardDeleteProject(created.id);
				}
				return realUpdateEntry(...args);
			});

			const updated = await projects.updateProject(created.id, { name: 'Delayed' }, ACTOR);

			const snapshot = await catalog.getCurrentSnapshot();
			expect(updated.name).toBe('Delayed');
			expect(snapshot.projects[0].status).toBe('deleted');
		});

		it('returns 412 when If-Match becomes stale during the CAS', async () => {
			const created = await projects.createProject({ name: 'Original', description: 'D' }, ACTOR);
			const metaKey = paths.project(created.id).meta;
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (!raced && key === metaKey && options?.onlyIfEtagMatches) {
					raced = true;
					const current = await (await bucket.get(metaKey))!.json<any>();
					await realPut(
						metaKey,
						JSON.stringify({ ...current, name: 'Racer', updated_at: '2099-01-01T00:00:00.000Z' }),
					);
				}
				return realPut(key, value, options);
			});

			await expect(
				projects.updateProject(created.id, { description: 'Mine' }, ACTOR, created.updated_at),
			).rejects.toBeInstanceOf(PreconditionFailedError);

			const stored = await projects.getProject(created.id);
			expect(stored.name).toBe('Racer');
			expect(stored.description).toBe('D');
		});

		it('does not resurrect a project deleted during an update', async () => {
			const created = await projects.createProject({ name: 'Original', description: 'D' }, ACTOR);
			const metaKey = paths.project(created.id).meta;
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
				if (!raced && key === metaKey && options?.onlyIfEtagMatches) {
					raced = true;
					await projects.deleteProject(created.id, ACTOR);
				}
				return realPut(key, value, options);
			});

			await expect(
				projects.updateProject(created.id, { name: 'Resurrected' }, ACTOR),
			).rejects.toBeInstanceOf(NotFoundError);

			const stored = await projects.getProject(created.id);
			const snapshot = await catalog.getCurrentSnapshot();
			expect(stored.status).toBe('deleted');
			expect(snapshot.projects[0].status).toBe('deleted');
		});

		it('updates name and description', async () => {
			const created = await projects.createProject({ name: 'Old', description: 'old desc' }, ACTOR);

			const updated = await projects.updateProject(
				created.id,
				{ name: 'New', description: 'new desc' },
				ACTOR,
			);

			expect(updated.name).toBe('New');
			expect(updated.description).toBe('new desc');

			// Verify snapshot also updated
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects[0].name).toBe('New');
		});

		it('partially updates — only changes provided fields', async () => {
			const created = await projects.createProject(
				{ name: 'Keep', description: 'Change me', tags: ['keep'] },
				ACTOR,
			);

			const updated = await projects.updateProject(created.id, { description: 'Changed' }, ACTOR);

			expect(updated.name).toBe('Keep');
			expect(updated.description).toBe('Changed');
			expect(updated.tags).toEqual(['keep']);
		});

		it('persists the federation opt-in and preserves it across unrelated updates', async () => {
			const created = await projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			expect(created.federation).toBeUndefined();

			const enabled = await projects.updateProject(
				created.id,
				{ federation: { enabled: true, target: 'data' } },
				ACTOR,
			);
			expect(enabled.federation).toEqual({ enabled: true, target: 'data' });
			// Round-trips through storage (parses against ProjectSchema).
			expect((await projects.getProject(created.id)).federation).toEqual({
				enabled: true,
				target: 'data',
			});

			// An unrelated update keeps the federation setting (not wiped).
			const renamed = await projects.updateProject(created.id, { name: 'P2' }, ACTOR);
			expect(renamed.federation).toEqual({ enabled: true, target: 'data' });
		});

		it('throws NotFoundError for missing project', async () => {
			await expect(
				projects.updateProject('proj_01HXY00000000000000000000' as ProjectId, { name: 'X' }, ACTOR),
			).rejects.toThrow(NotFoundError);
		});

		it('rejects a stale expectedVersion with PreconditionFailedError (If-Match)', async () => {
			const created = await projects.createProject({ name: 'P', description: 'd' }, ACTOR);

			// A precondition that no longer matches the resource's current version.
			await expect(
				projects.updateProject(created.id, { name: 'X' }, ACTOR, 'stale-version-token'),
			).rejects.toThrow(PreconditionFailedError);

			// The rejection must be a no-op: the stored project is untouched.
			expect((await projects.getProject(created.id)).name).toBe('P');

			// The matching version is accepted, proving the guard checks the token
			// rather than rejecting every precondition.
			const ok = await projects.updateProject(created.id, { name: 'X' }, ACTOR, created.updated_at);
			expect(ok.name).toBe('X');
		});
	});

	describe('deleteProject (soft-delete)', () => {
		it('projects its tombstone when hard deletion wins before the catalog write', async () => {
			const created = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			const realUpdateEntry = catalog.updateProjectEntry.bind(catalog);
			let purged = false;
			vi.spyOn(catalog, 'updateProjectEntry').mockImplementation(async (...args) => {
				if (!purged && args[0] === 'project.delete') {
					purged = true;
					await projects.hardDeleteProject(created.id);
				}
				return realUpdateEntry(...args);
			});

			await projects.deleteProject(created.id, ACTOR);

			const snapshot = await catalog.getCurrentSnapshot();
			expect(purged).toBe(true);
			expect(snapshot.projects[0].status).toBe('deleted');
		});

		it('marks the project deleted but retains its bytes', async () => {
			const created = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);

			await projects.deleteProject(created.id, ACTOR);

			// Snapshot entry is kept, tombstoned, and hidden from listProjects.
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects).toHaveLength(1);
			expect(snap.projects[0].status).toBe('deleted');
			expect(await projects.listProjects()).toEqual([]);

			// project.json survives, with status flipped to 'deleted'.
			const stored = await projects.getProject(created.id);
			expect(stored.status).toBe('deleted');
			expect(await listAllKeys(bucket, `projects/${created.id}/`)).not.toEqual([]);
		});

		it('is idempotent — a repeated delete is a no-op', async () => {
			const created = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			await projects.deleteProject(created.id, ACTOR);
			await projects.deleteProject(created.id, ACTOR);

			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects).toHaveLength(1);
			expect(snap.projects[0].status).toBe('deleted');
		});

		it('throws NotFoundError for missing project', async () => {
			await expect(
				projects.deleteProject('proj_01HXY00000000000000000000' as ProjectId, ACTOR),
			).rejects.toThrow(NotFoundError);
		});

		it('rejects a stale expectedVersion with PreconditionFailedError (If-Match)', async () => {
			const created = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);

			await expect(
				projects.deleteProject(created.id, ACTOR, 'stale-version-token'),
			).rejects.toThrow(PreconditionFailedError);

			// The project was NOT deleted: a failed precondition must be a no-op.
			expect((await projects.getProject(created.id)).status).toBe('active');
		});
	});

	describe('hardDeleteProject', () => {
		it('refuses to hard-delete a project that is not soft-deleted', async () => {
			const live = await projects.createProject({ name: 'Live', description: 'D' }, ACTOR);
			await expect(projects.hardDeleteProject(live.id)).rejects.toThrow(/status is "active"/);
			expect(await listAllKeys(bucket, `projects/${live.id}/`)).not.toEqual([]);
		});

		it('removes the entire subtree of a soft-deleted project', async () => {
			const doomed = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			const survivor = await projects.createProject({ name: 'Survivor', description: 'D' }, ACTOR);
			await notebooks.createNotebook(
				doomed.id,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'd', readme: '# r' },
				ACTOR,
			);
			const integrationId = 'intg-0000000000000001' as never;
			await bucket.put(
				paths.project(doomed.id).integration(integrationId).head,
				JSON.stringify({ marker: 'doomed integration' }),
			);
			await bucket.put(
				paths.project(doomed.id).integration(integrationId).version(1),
				JSON.stringify({ marker: 'doomed version' }),
			);
			await bucket.put(
				paths.project(doomed.id).integrationNameClaim('prod'),
				JSON.stringify({ integration_id: integrationId }),
			);
			await bucket.put(
				paths.project(survivor.id).integration(integrationId).head,
				JSON.stringify({ marker: 'survivor integration' }),
			);

			await projects.deleteProject(doomed.id, ACTOR);
			await projects.hardDeleteProject(doomed.id);

			expect(await listAllKeys(bucket, `projects/${doomed.id}/`)).toEqual([]);
			expect(await bucket.get(`projects/${doomed.id}/project.json`)).toBeNull();
			expect(
				await bucket.get(paths.project(survivor.id).integration(integrationId).head),
			).not.toBeNull();
		});

		it('removes every app claim, including ones the per-notebook cleanup left behind', async () => {
			const doomed = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			const a = await notebooks.createNotebook(
				doomed.id,
				{ title: 'A', description: 'D', code: 'v1' },
				ACTOR,
			);
			const b = await notebooks.createNotebook(
				doomed.id,
				{ title: 'B', description: 'D', code: 'v1' },
				ACTOR,
			);
			const keeper = await projects.createProject({ name: 'Keeper', description: 'D' }, ACTOR);
			const kept = await notebooks.createNotebook(
				keeper.id,
				{ title: 'K', description: 'D', code: 'v1' },
				ACTOR,
			);
			// Claims live under `_system/`, outside the project subtree, and project
			// ids never recur — so no future claimApp would ever self-heal these.
			for (const [pid, nid] of [
				[doomed.id, a.id],
				[doomed.id, b.id],
				[keeper.id, kept.id],
			] as const) {
				await bucket.put(
					paths.appClaim(pid, nid),
					JSON.stringify({
						session_id: 'sess-0000000000000001',
						claimed_at: new Date().toISOString(),
					}),
				);
			}

			await projects.deleteProject(doomed.id, ACTOR);
			await projects.hardDeleteProject(doomed.id);

			expect(await listAllKeys(bucket, paths.appClaimsForProject(doomed.id))).toEqual([]);
			// Another project's claim is untouched.
			expect(await bucket.get(paths.appClaim(keeper.id, kept.id))).not.toBeNull();
		});
	});

	describe('sweepDeletedProjects', () => {
		it('purges only soft-deleted projects past the grace period', async () => {
			// Project to be deleted, with a notebook and an extra version.
			const doomed = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			const nb = await notebooks.createNotebook(
				doomed.id,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'd', readme: '# r' },
				ACTOR,
			);
			await notebooks.updateNotebook(doomed.id, nb.id, { code: 'v2', message: 'm' }, ACTOR);

			// A SURVIVOR project that must be untouched by the sweep.
			const survivor = await projects.createProject({ name: 'Survivor', description: 'S' }, ACTOR);
			const survivorNb = await notebooks.createNotebook(
				survivor.id,
				{ title: 'Keep', description: 'D', code: 's1', deps: 'sd' },
				ACTOR,
			);

			const doomedPrefix = `projects/${doomed.id}/`;
			const survivorPrefix = `projects/${survivor.id}/`;
			const survivorKeysBefore = await listAllKeys(bucket, survivorPrefix);
			expect(survivorKeysBefore.length).toBeGreaterThan(0);

			await projects.deleteProject(doomed.id, ACTOR);

			// Within the grace period nothing is purged: the bytes still linger.
			expect(await projects.sweepDeletedProjects()).toBe(0);
			expect((await listAllKeys(bucket, doomedPrefix)).length).toBeGreaterThan(0);

			// Past the grace period (retentionMs 0) the soft-deleted project is purged.
			expect(await projects.sweepDeletedProjects(0)).toBe(1);

			// Nothing remains under projects/{pid}/ and the snapshot entry is gone.
			expect(await listAllKeys(bucket, doomedPrefix)).toEqual([]);
			const snap = await catalog.getCurrentSnapshot();
			expect(snap.projects.map((p) => p.id)).not.toContain(doomed.id);

			// Live data survived: the survivor project, its keys, and its notebook
			// content are all intact and untouched.
			expect(await listAllKeys(bucket, survivorPrefix)).toEqual(survivorKeysBefore);
			expect((await projects.listProjects()).map((p) => p.id)).toContain(survivor.id);
			expect(await notebooks.getNotebookContent(survivor.id, survivorNb.id)).toBe('s1');
		});
	});
});
