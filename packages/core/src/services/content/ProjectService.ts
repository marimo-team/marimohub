import type { Bucket } from '../../ports/bucket';
import { canAct, canSeeProjectEntry } from '../../authz';
import type { Role } from '../../constants';
import { Millis } from '../../duration';
import { assertVersionMatch, ConflictError, NotFoundError } from '../../errors';
import { createProjectId, SYSTEM_ACTOR } from '../../ids';
import type { ProjectId, UserId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { metricsObserver, saga } from '../../saga';
import { parseStored, ProjectSchema, toPublicProjectEntry } from '../../schema';
import type {
	Project,
	ProjectFederation,
	ProjectMember,
	PublicProjectEntry,
	Snapshot,
} from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { deleteByPrefix } from '../catalog/storage';

/** Grace period before a soft-deleted project's storage is purged by the GC sweep. */
export const DEFAULT_DELETED_PROJECT_RETENTION_MS = Millis.days(30);

export interface CreateProjectInput {
	name: string;
	description: string;
	tags?: string[];
	federation?: ProjectFederation;
}

export interface UpdateProjectInput {
	name?: string;
	description?: string;
	tags?: string[];
	federation?: ProjectFederation;
}

export class ProjectService {
	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
		private metrics: Metrics = noopMetrics,
	) {}

	/**
	 * List projects, newest-first paging applied by the caller. Soft-deleted
	 * projects are always hidden. When `filter` is passed with a null/undefined
	 * `defaultRole` (deployment `MARIMOHUB_DEFAULT_ROLE=none`), the list is
	 * restricted to projects the caller can see (owner or member); with a
	 * `defaultRole` set every authenticated user is a viewer, so nothing is hidden.
	 */
	async listProjects(filter?: {
		userId: UserId;
		defaultRole?: Role | null;
	}): Promise<PublicProjectEntry[]> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const live = snapshot.projects.filter((p) => p.status !== 'deleted');
		if (!filter || filter.defaultRole != null) {
			return live.map(toPublicProjectEntry);
		}
		const visible: typeof live = [];
		for (const entry of live) {
			const seen = canSeeProjectEntry(entry, filter.userId, filter.defaultRole);
			// `null` = the entry predates `member_ids`, so visibility can't be decided
			// from the snapshot alone; fall back to the authoritative project.json.
			if (seen ?? (await this.canSeeProject(entry.id, filter.userId))) {
				visible.push(entry);
			}
		}
		return visible.map(toPublicProjectEntry);
	}

	private async canSeeProject(id: ProjectId, userId: UserId): Promise<boolean> {
		return canAct(await this.getProject(id), userId, 'viewer', null);
	}

	async getProject(id: ProjectId): Promise<Project> {
		const obj = await this.bucket.get(paths.project(id).meta);
		if (!obj) {
			throw new NotFoundError(`Project ${id} not found`);
		}
		return parseStored(ProjectSchema, await obj.json(), paths.project(id).meta);
	}

	async createProject(input: CreateProjectInput, actor: UserId): Promise<Project> {
		const id = createProjectId();
		const now = new Date().toISOString();

		const project: Project = {
			schema_version: 1,
			id,
			name: input.name,
			description: input.description,
			owner: actor,
			members: [{ user_id: actor, role: 'admin' }],
			status: 'active',
			created_at: now,
			updated_at: now,
			tags: input.tags ?? [],
			federation: input.federation,
		};

		// Write the project meta blob, then record it in the catalog. If the catalog
		// write fails the project is unreferenced, so the saga compensates by deleting
		// the orphaned blob.
		await saga(metricsObserver(this.metrics, 'saga.project_create'))
			.step('write_meta', {
				do: () => this.bucket.put(paths.project(id).meta, JSON.stringify(project)),
				compensate: () => this.bucket.delete(paths.project(id).meta),
			})
			.step('catalog', () =>
				this.catalog.mutateSnapshot(
					'project.create',
					actor,
					(snap: Snapshot) => ({
						...snap,
						projects: [
							...snap.projects,
							{
								id,
								name: project.name,
								description: project.description,
								owner: actor,
								status: 'active' as const,
								created_at: now,
								updated_at: now,
								notebook_count: 0,
								notebooks: [],
								member_ids: project.members.map((m) => m.user_id),
							},
						],
					}),
					{ project_id: id },
				),
			)
			.run();

		return project;
	}

	async updateProject(
		id: ProjectId,
		input: UpdateProjectInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<Project> {
		const existing = await this.getProject(id);
		assertVersionMatch(existing.updated_at, expectedVersion);
		const now = new Date().toISOString();

		const updated: Project = {
			...existing,
			name: input.name ?? existing.name,
			description: input.description ?? existing.description,
			tags: input.tags ?? existing.tags,
			federation: input.federation ?? existing.federation,
			updated_at: now,
		};

		await this.bucket.put(paths.project(id).meta, JSON.stringify(updated));

		await this.catalog.updateProjectEntry('project.update', actor, id, () => ({
			name: updated.name,
			description: updated.description,
			updated_at: now,
		}));

		return updated;
	}

	/** Add a member at `role`. 409 if the user is already a member. */
	async addMember(id: ProjectId, userId: UserId, role: Role, actor: UserId): Promise<Project> {
		const existing = await this.getProject(id);
		if (existing.members.some((m) => m.user_id === userId)) {
			throw new ConflictError(`User ${userId} is already a member of project ${id}`);
		}
		return this.writeMembers(existing, [...existing.members, { user_id: userId, role }], actor);
	}

	/**
	 * Change a member's role. 404 if not a member. The owner's membership is
	 * immutable (they are implicitly admin), which keeps at least one admin on the
	 * project at all times.
	 */
	async updateMemberRole(
		id: ProjectId,
		userId: UserId,
		role: Role,
		actor: UserId,
	): Promise<Project> {
		const existing = await this.getProject(id);
		if (userId === existing.owner) {
			throw new ConflictError(`Cannot change the role of the project owner`);
		}
		if (!existing.members.some((m) => m.user_id === userId)) {
			throw new NotFoundError(`User ${userId} is not a member of project ${id}`);
		}
		const members = existing.members.map((m) => (m.user_id === userId ? { ...m, role } : m));
		return this.writeMembers(existing, members, actor);
	}

	/** Remove a member. 404 if not a member; the owner cannot be removed. */
	async removeMember(id: ProjectId, userId: UserId, actor: UserId): Promise<Project> {
		const existing = await this.getProject(id);
		if (userId === existing.owner) {
			throw new ConflictError(`Cannot remove the project owner`);
		}
		if (!existing.members.some((m) => m.user_id === userId)) {
			throw new NotFoundError(`User ${userId} is not a member of project ${id}`);
		}
		const members = existing.members.filter((m) => m.user_id !== userId);
		return this.writeMembers(existing, members, actor);
	}

	// The authoritative roster (with roles) lives on project.json; the snapshot
	// entry carries only `member_ids` (a denormalized copy of the user ids) so the
	// project list can be filtered per-caller in-memory. A membership change
	// rewrites the meta blob and, in the same catalog CAS, bumps `updated_at` and
	// refreshes `member_ids` to match.
	private async writeMembers(
		existing: Project,
		members: ProjectMember[],
		actor: UserId,
	): Promise<Project> {
		const now = new Date().toISOString();
		const updated: Project = { ...existing, members, updated_at: now };
		await this.bucket.put(paths.project(existing.id).meta, JSON.stringify(updated));
		await this.catalog.updateProjectEntry('project.members', actor, existing.id, () => ({
			updated_at: now,
			member_ids: members.map((m) => m.user_id),
		}));
		return updated;
	}

	/**
	 * Soft-delete a project: flip `status` to 'deleted' and hide it from listings.
	 * The bytes are retained until {@link sweepDeletedProjects} purges them after
	 * the grace period, so an accidental delete is recoverable in the meantime.
	 * Mirrors `NotebookService.deleteNotebook`.
	 */
	async deleteProject(id: ProjectId, actor: UserId, expectedVersion?: string): Promise<void> {
		const existing = await this.getProject(id); // ensure exists (404 otherwise)
		assertVersionMatch(existing.updated_at, expectedVersion);
		// Idempotent: a project already soft-deleted is left untouched so a repeated
		// delete (retry / double-click) is a no-op.
		if (existing.status === 'deleted') {
			return;
		}
		const now = new Date().toISOString();

		// Soft-delete: tombstone the project.json (deletion time = updated_at).
		const updated: Project = { ...existing, status: 'deleted', updated_at: now };
		await this.bucket.put(paths.project(id).meta, JSON.stringify(updated));

		// Soft-delete in the snapshot: keep the entry (and its nested notebooks) so
		// the GC sweep can find and purge it later, but mark it deleted so it drops
		// out of listProjects immediately.
		await this.catalog.updateProjectEntry('project.delete', actor, id, () => ({
			status: 'deleted' as const,
			updated_at: now,
		}));
	}

	/**
	 * Hard-delete a project's entire object subtree (`projects/{id}/`), reclaiming
	 * every notebook file, version, README, and dep. Refuses unless the project is
	 * soft-deleted (`status === 'deleted'`) so a live project can never be purged by
	 * mistake. The destructive half of the soft-delete lifecycle; callers (the GC
	 * sweep) own removing the snapshot entry.
	 */
	async hardDeleteProject(id: ProjectId): Promise<void> {
		const project = await this.getProject(id);
		if (project.status !== 'deleted') {
			throw new Error(
				`Refusing to hard-delete project ${id}: status is "${project.status}", expected "deleted"`,
			);
		}

		// `paths.project(id).meta` is `projects/{id}/project.json`; every file for
		// this project lives under the same `projects/{id}/` prefix, so deleting that
		// prefix reclaims the whole subtree. Derive the prefix from `paths` (strip
		// the `project.json` filename) so it stays consistent with the path layout.
		const prefix = paths.project(id).meta.replace(/project\.json$/, '');
		await deleteByPrefix(this.bucket, prefix);
	}

	/**
	 * GC sweep: hard-delete soft-deleted projects whose grace period has elapsed
	 * (deletion time = `updated_at`), then drop them from the snapshot. Returns the
	 * number purged. Files are deleted first and the snapshot mutated LAST, so a
	 * mid-sweep failure leaves the catalog pointing at a (possibly partially
	 * deleted) project that is safe to retry. Idempotent.
	 */
	async sweepDeletedProjects(
		retentionMs: number = DEFAULT_DELETED_PROJECT_RETENTION_MS,
	): Promise<number> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const now = Date.now();
		const stale = snapshot.projects.filter(
			(p) => p.status === 'deleted' && now - Date.parse(p.updated_at) >= retentionMs,
		);
		if (stale.length === 0) return 0;

		for (const p of stale) {
			await this.hardDeleteProject(p.id);
		}

		const staleIds = new Set(stale.map((p) => p.id));
		await this.catalog.mutateSnapshot(
			'project.gc',
			SYSTEM_ACTOR,
			(snap: Snapshot) => ({
				...snap,
				projects: snap.projects.filter((p) => !staleIds.has(p.id)),
			}),
			{ project_ids: stale.map((p) => p.id) },
		);

		return stale.length;
	}
}
