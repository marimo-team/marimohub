import type { Bucket } from '../../ports/bucket';
import { canAct, canSeeProjectEntry, isSuperAdmin, subjectDefaultRole } from '../../authz';
import type { AuthSubject, AuthzPolicy } from '../../authz';
import { memberRefMatchesSelector, normalizeEmail } from '../../identityMatch';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { AssignableRole } from '../../constants';
import { Millis } from '../../duration';
import { assertVersionMatch, ConflictError, NotFoundError, ValidationError } from '../../errors';
import { createProjectId, SYSTEM_ACTOR } from '../../ids';
import type { ProjectId, SnapshotId, UserId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { metricsObserver, saga } from '../../saga';
import { parseStored, ProjectSchema, readStored, toPublicProjectEntry } from '../../schema';
import type {
	Project,
	ProjectFederation,
	ProjectMember,
	PublicProjectEntry,
	Snapshot,
} from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { mutateObject, mutateObjectWithOutcome } from '../catalog/cas';
import { deleteByPrefix } from '../catalog/storage';
import { loadProjectCatalogPatch, projectCatalogPatch } from './catalogProjection';

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

export interface MemberMutationResult {
	project: Project;
	mutationId: SnapshotId;
}

export interface ExistingMemberMutationResult extends MemberMutationResult {
	previousMember: ProjectMember;
}

export interface ProjectDeleteMutationResult {
	project: Project;
	mutationId: SnapshotId;
}

function normalizeProjectName(name: string): string {
	const normalized = name.replaceAll(/[\p{Cc}\p{Cf}]/gu, '');
	if (normalized.trim().length === 0) {
		throw new ValidationError('Project name must contain a visible character.');
	}
	return normalized;
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
		const name = normalizeProjectName(input.name);

		const project: Project = {
			schema_version: 1,
			id,
			name,
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
		const key = paths.project(id).meta;
		const name = input.name === undefined ? undefined : normalizeProjectName(input.name);

		const updated = await mutateObject(
			this.bucket,
			key,
			(raw) => parseStored(ProjectSchema, raw, key),
			(current) => {
				assertVersionMatch(current.updated_at, expectedVersion);
				if (current.status === 'deleted') {
					throw new NotFoundError(`Project ${id} not found`);
				}
				return {
					...current,
					name: name ?? current.name,
					description: input.description ?? current.description,
					tags: input.tags ?? current.tags,
					federation: input.federation ?? current.federation,
					updated_at: new Date().toISOString(),
				};
			},
			{ notFound: () => new NotFoundError(`Project ${id} not found`) },
		);

		await this.catalog.updateProjectEntry('project.update', actor, id, (entry) =>
			loadProjectCatalogPatch(this.bucket, id, entry),
		);

		return updated;
	}

	/**
	 * Add a member at `role`, identified by user id (known user) or email (pending
	 * invite for someone who hasn't logged in yet — see ProjectMemberSchema).
	 * 409 if any of the person's identifiers is already on the roster.
	 */
	async addMember(
		id: ProjectId,
		member: NewMember,
		role: AssignableRole,
		actor: UserId,
	): Promise<Project> {
		return (await this.addMemberWithMutation(id, member, role, actor)).project;
	}

	async addMemberWithMutation(
		id: ProjectId,
		member: NewMember,
		role: AssignableRole,
		actor: UserId,
	): Promise<MemberMutationResult> {
		const userId = 'user_id' in member ? member.user_id : undefined;
		const email = member.email !== undefined ? normalizeEmail(member.email) : undefined;
		return this.writeMembers(
			id,
			(current) => {
				const duplicate = current.members.some(
					(m) =>
						(userId !== undefined && m.user_id === userId) ||
						(email !== undefined && m.email === email),
				);
				if (duplicate) {
					throw new ConflictError(`${userId ?? email} is already a member of project ${id}`);
				}
				const row: ProjectMember =
					userId !== undefined ? { user_id: userId, role } : { email: email as string, role };
				return [...current.members, row];
			},
			actor,
		);
	}

	/**
	 * Change a member's role. `selector` is the member's user id or email. 404 if
	 * not a member. The owner's membership is immutable (they are implicitly
	 * admin), which keeps at least one admin on the project at all times.
	 */
	async updateMemberRole(
		id: ProjectId,
		selector: string,
		role: AssignableRole,
		actor: UserId,
	): Promise<Project> {
		return (await this.updateMemberRoleWithMutation(id, selector, role, actor)).project;
	}

	async updateMemberRoleWithMutation(
		id: ProjectId,
		selector: string,
		role: AssignableRole,
		actor: UserId,
	): Promise<ExistingMemberMutationResult> {
		let previousMember: ProjectMember | undefined;
		const { project, mutationId } = await this.writeMembers(
			id,
			(current) => {
				if (selector === current.owner) {
					throw new ConflictError(`Cannot change the role of the project owner`);
				}
				previousMember = current.members.find((m) => memberRefMatchesSelector(m, selector));
				if (!previousMember) {
					throw new NotFoundError(`${selector} is not a member of project ${id}`);
				}
				return current.members.map((m) =>
					memberRefMatchesSelector(m, selector) ? { ...m, role } : m,
				);
			},
			actor,
		);
		return { project, mutationId, previousMember: previousMember! };
	}

	/**
	 * Remove a member by user id or email. 404 if not a member; the owner cannot
	 * be removed.
	 */
	async removeMember(id: ProjectId, selector: string, actor: UserId): Promise<Project> {
		return (await this.removeMemberWithMutation(id, selector, actor)).project;
	}

	async removeMemberWithMutation(
		id: ProjectId,
		selector: string,
		actor: UserId,
	): Promise<ExistingMemberMutationResult> {
		let previousMember: ProjectMember | undefined;
		const { project, mutationId } = await this.writeMembers(
			id,
			(current) => {
				if (selector === current.owner) {
					throw new ConflictError(`Cannot remove the project owner`);
				}
				previousMember = current.members.find((m) => memberRefMatchesSelector(m, selector));
				if (!previousMember) {
					throw new NotFoundError(`${selector} is not a member of project ${id}`);
				}
				return current.members.filter((m) => !memberRefMatchesSelector(m, selector));
			},
			actor,
		);
		return { project, mutationId, previousMember: previousMember! };
	}

	// The authoritative roster (with roles) lives on project.json; the snapshot
	// entry carries only `member_ids`/`member_emails` (denormalized copies of the
	// identifiers) so the project list can be filtered per-caller in-memory. A
	// membership change rewrites the meta blob and, in the same catalog CAS, bumps
	// `updated_at` and refreshes both rosters to match.
	private async writeMembers(
		id: ProjectId,
		deriveMembers: (current: Project) => ProjectMember[],
		actor: UserId,
	): Promise<MemberMutationResult> {
		const key = paths.project(id).meta;
		const updated = await mutateObject(
			this.bucket,
			key,
			(raw) => parseStored(ProjectSchema, raw, key),
			(current) => {
				if (current.status === 'deleted') {
					throw new NotFoundError(`Project ${id} not found`);
				}
				return {
					...current,
					members: deriveMembers(current),
					updated_at: new Date().toISOString(),
				};
			},
			{ notFound: () => new NotFoundError(`Project ${id} not found`) },
		);
		const snapshot = await this.catalog.updateProjectEntry('project.members', actor, id, (entry) =>
			loadProjectCatalogPatch(this.bucket, id, entry),
		);
		return { project: updated, mutationId: snapshot.snapshot_id };
	}

	/**
	 * Soft-delete a project: flip `status` to 'deleted' and hide it from listings.
	 * The bytes are retained until {@link sweepDeletedProjects} purges them after
	 * the grace period, so an accidental delete is recoverable in the meantime.
	 * Mirrors `NotebookService.deleteNotebook`.
	 */
	async deleteProject(id: ProjectId, actor: UserId, expectedVersion?: string): Promise<void> {
		await this.deleteProjectWithMutation(id, actor, expectedVersion);
	}

	async deleteProjectWithMutation(
		id: ProjectId,
		actor: UserId,
		expectedVersion?: string,
	): Promise<ProjectDeleteMutationResult | null> {
		const key = paths.project(id).meta;
		const { value: updated, written } = await mutateObjectWithOutcome(
			this.bucket,
			key,
			(raw) => parseStored(ProjectSchema, raw, key),
			(current) => {
				assertVersionMatch(current.updated_at, expectedVersion);
				if (current.status === 'deleted') return null;
				return {
					...current,
					status: 'deleted' as const,
					updated_at: new Date().toISOString(),
				};
			},
			{ notFound: () => new NotFoundError(`Project ${id} not found`) },
		);
		if (!written) return null;

		// Soft-delete in the snapshot: keep the entry (and its nested notebooks) so
		// the GC sweep can find and purge it later, but mark it deleted so it drops
		// out of listProjects immediately.
		const snapshot = await this.catalog.updateProjectEntry(
			'project.delete',
			actor,
			id,
			async (entry) =>
				(await loadProjectCatalogPatch(this.bucket, id, entry)) ??
				projectCatalogPatch(updated, entry),
		);
		return { project: updated, mutationId: snapshot.snapshot_id };
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
