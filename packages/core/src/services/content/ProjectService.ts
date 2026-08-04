import type { Bucket } from '../../ports/bucket';
import { canAct, canSeeProjectEntry, isSuperAdmin, subjectDefaultRole } from '../../authz';
import type { AuthSubject, AuthzPolicy } from '../../authz';
import { memberRefMatchesSelector, normalizeEmail } from '../../identityMatch';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { Role } from '../../constants';
import { Millis } from '../../duration';
import { assertVersionMatch, ConflictError, NotFoundError } from '../../errors';
import { createProjectId, SYSTEM_ACTOR } from '../../ids';
import type { ProjectId, UserId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { metricsObserver, saga } from '../../saga';
import { ProjectSchema, readStored, toPublicProjectEntry } from '../../schema';
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

/**
 * Identifier for a member being added: a known user id, or an email invite.
 * An id add may also carry the person's known email (from the identity
 * directory) — it is not stored, but lets the duplicate check catch a pending
 * invite row for the same person, so one human can never hold two rows (which
 * would make demote/remove of one row silently fail to revoke the other).
 */
export type NewMember = { user_id: UserId; email?: string } | { email: string };

export class ProjectService {
	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
		private metrics: Metrics = noopMetrics,
	) {}

	/**
	 * List projects, newest-first paging applied by the caller. Soft-deleted
	 * projects are always hidden. When `filter` is passed with a null/undefined
	 * `policy.defaultRole` (deployment `MARIMOHUB_DEFAULT_ROLE=none`), the list
	 * is restricted to projects the caller can see (owner or member); with a
	 * `defaultRole` set — or when the caller is a super admin — every project
	 * is visible, so nothing is hidden.
	 */
	async listProjects(filter?: {
		subject: AuthSubject;
		policy?: AuthzPolicy;
	}): Promise<PublicProjectEntry[]> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const live = snapshot.projects.filter((p) => p.status !== 'deleted');
		if (
			!filter ||
			subjectDefaultRole(filter.subject, filter.policy) != null ||
			isSuperAdmin(filter.subject, filter.policy?.superAdmins)
		) {
			return live.map(toPublicProjectEntry);
		}
		const visibility = await mapWithConcurrency(live, BUCKET_SCAN_CONCURRENCY, async (entry) => {
			const seen = canSeeProjectEntry(entry, filter.subject, filter.policy);
			// `null` = the entry predates `member_ids`, so visibility can't be decided
			// from the snapshot alone; fall back to the authoritative project.json.
			return seen ?? (await this.canSeeProject(entry.id, filter.subject));
		});
		return live.filter((_, i) => visibility[i]).map(toPublicProjectEntry);
	}

	// Only reached when the fast path above didn't return, i.e. the caller is
	// neither a super admin nor covered by a defaultRole — so no policy here.
	private async canSeeProject(id: ProjectId, subject: AuthSubject): Promise<boolean> {
		return canAct(await this.getProject(id), subject, 'viewer', undefined);
	}

	async getProject(id: ProjectId): Promise<Project> {
		const obj = await this.bucket.get(paths.project(id).meta);
		if (!obj) {
			throw new NotFoundError(`Project ${id} not found`);
		}
		return readStored(ProjectSchema, obj, paths.project(id).meta);
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
								member_ids: project.members.flatMap((m) =>
									m.user_id !== undefined ? [m.user_id] : [],
								),
								member_emails: [],
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

	/**
	 * Add a member at `role`, identified by user id (known user) or email (pending
	 * invite for someone who hasn't logged in yet — see ProjectMemberSchema).
	 * 409 if any of the person's identifiers is already on the roster.
	 */
	async addMember(id: ProjectId, member: NewMember, role: Role, actor: UserId): Promise<Project> {
		const existing = await this.getProject(id);
		const userId = 'user_id' in member ? member.user_id : undefined;
		const email = member.email !== undefined ? normalizeEmail(member.email) : undefined;
		const duplicate = existing.members.some(
			(m) =>
				(userId !== undefined && m.user_id === userId) ||
				(email !== undefined && m.email === email),
		);
		if (duplicate) {
			throw new ConflictError(`${userId ?? email} is already a member of project ${id}`);
		}
		const row: ProjectMember =
			userId !== undefined ? { user_id: userId, role } : { email: email as string, role };
		return this.writeMembers(existing, [...existing.members, row], actor);
	}

	/**
	 * Change a member's role. `selector` is the member's user id or email. 404 if
	 * not a member. The owner's membership is immutable (they are implicitly
	 * admin), which keeps at least one admin on the project at all times.
	 */
	async updateMemberRole(
		id: ProjectId,
		selector: string,
		role: Role,
		actor: UserId,
	): Promise<Project> {
		const existing = await this.getProject(id);
		if (selector === existing.owner) {
			throw new ConflictError(`Cannot change the role of the project owner`);
		}
		if (!existing.members.some((m) => memberRefMatchesSelector(m, selector))) {
			throw new NotFoundError(`${selector} is not a member of project ${id}`);
		}
		const members = existing.members.map((m) =>
			memberRefMatchesSelector(m, selector) ? { ...m, role } : m,
		);
		return this.writeMembers(existing, members, actor);
	}

	/**
	 * Remove a member by user id or email. 404 if not a member; the owner cannot
	 * be removed.
	 */
	async removeMember(id: ProjectId, selector: string, actor: UserId): Promise<Project> {
		const existing = await this.getProject(id);
		if (selector === existing.owner) {
			throw new ConflictError(`Cannot remove the project owner`);
		}
		if (!existing.members.some((m) => memberRefMatchesSelector(m, selector))) {
			throw new NotFoundError(`${selector} is not a member of project ${id}`);
		}
		const members = existing.members.filter((m) => !memberRefMatchesSelector(m, selector));
		return this.writeMembers(existing, members, actor);
	}

	// The authoritative roster (with roles) lives on project.json; the snapshot
	// entry carries only `member_ids`/`member_emails` (denormalized copies of the
	// identifiers) so the project list can be filtered per-caller in-memory. A
	// membership change rewrites the meta blob and, in the same catalog CAS, bumps
	// `updated_at` and refreshes both rosters to match.
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
			member_ids: members.flatMap((m) => (m.user_id !== undefined ? [m.user_id] : [])),
			member_emails: members.flatMap((m) => (m.email !== undefined ? [m.email] : [])),
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
		// App-singleton claims live under `_system/`, outside the project subtree —
		// reclaim them too or they leak forever (project ids never recur).
		await deleteByPrefix(this.bucket, paths.appClaimsForProject(id));
		await deleteByPrefix(this.bucket, paths.editorClaimsForProject(id));
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
