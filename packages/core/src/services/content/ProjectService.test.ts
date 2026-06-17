import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundError } from '../../errors';
import { UserId } from '../../ids';
import type { ProjectId } from '../../ids';
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
			const list = await projects.listProjects({ subject: STRANGER, defaultRole: 'viewer' });
			expect(list.map((p) => p.name)).toEqual(['A']);
		});

		it('hides projects a caller does not own or belong to when defaultRole is null', async () => {
			await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			// Owner sees it; a stranger does not.
			expect(await projects.listProjects({ subject: OWNER, defaultRole: null })).toHaveLength(1);
			expect(await projects.listProjects({ subject: STRANGER, defaultRole: null })).toEqual([]);
		});

		it('shows a project once the caller is added as a member', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { user_id: STRANGER.id }, 'viewer', ACTOR);
			const list = await projects.listProjects({ subject: STRANGER, defaultRole: null });
			expect(list.map((e) => e.id)).toEqual([p.id]);
		});

		it('shows a project to an email member via the denormalized roster', async () => {
			const p = await projects.createProject({ name: 'A', description: 'a' }, ACTOR);
			await projects.addMember(p.id, { email: STRANGER.email }, 'viewer', ACTOR);
			const list = await projects.listProjects({ subject: STRANGER, defaultRole: null });
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
			const list = await projects.listProjects({ subject: STRANGER, defaultRole: null });
			expect(list.map((e) => e.id)).toEqual([p.id]);
		});
	});

	describe('membership', () => {
		const MEMBER = UserId.parse('user_member');

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
			await projects.addMember(p.id, { email: 'Invitee@Example.COM' }, 'viewer', ACTOR);

			const stored = await projects.getProject(p.id);
			expect(stored.members).toContainEqual({ email: 'invitee@example.com', role: 'viewer' });
			const snap = await catalog.getCurrentSnapshot();
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
	});

	describe('deleteProject (soft-delete)', () => {
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
	});

	describe('hardDeleteProject', () => {
		it('refuses to hard-delete a project that is not soft-deleted', async () => {
			const live = await projects.createProject({ name: 'Live', description: 'D' }, ACTOR);
			await expect(projects.hardDeleteProject(live.id)).rejects.toThrow(/status is "active"/);
			expect(await listAllKeys(bucket, `projects/${live.id}/`)).not.toEqual([]);
		});

		it('removes the entire subtree of a soft-deleted project', async () => {
			const doomed = await projects.createProject({ name: 'Doomed', description: 'D' }, ACTOR);
			await notebooks.createNotebook(
				doomed.id,
				{ title: 'NB', description: 'D', code: 'v1', deps: 'd', readme: '# r' },
				ACTOR,
			);

			await projects.deleteProject(doomed.id, ACTOR);
			await projects.hardDeleteProject(doomed.id);

			expect(await listAllKeys(bucket, `projects/${doomed.id}/`)).toEqual([]);
			expect(await bucket.get(`projects/${doomed.id}/project.json`)).toBeNull();
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
