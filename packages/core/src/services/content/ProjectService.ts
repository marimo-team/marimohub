import type { Bucket } from '../../ports/bucket';
import { roleAtLeast } from '../../authz';
import { AuthorizationService } from '../authorization/AuthorizationService';
import { filterByLabelConstraints } from '../authorization/labelFilter';
import type {
	AuthorizationPolicy,
	AuthorizationSubject,
	ResourceSecurityPolicy,
} from '../authorization/AuthorizationService';
import { memberRefMatchesSelector, normalizeEmail } from '../../identityMatch';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { AssignableRole, Role } from '../../constants';
import { Millis } from '../../duration';
import {
	assertVersionMatch,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	PreconditionFailedError,
	ValidationError,
} from '../../errors';
import { createProjectId, SYSTEM_ACTOR } from '../../ids';
import type { ProjectId, SnapshotId, UserId } from '../../ids';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { metricsObserver, saga } from '../../saga';
import { parseStored, ProjectSchema, readStored, toPublicProjectEntry } from '../../schema';
import { normalizeSecurityLabels } from '../../securityLabels';
import type { ResourceSecurityLabels } from '../../securityLabels';
import type {
	Project,
	ProjectFederation,
	ProjectMember,
	PublicProjectEntry,
	Snapshot,
	SnapshotProjectEntry,
} from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { mutateObject, mutateObjectWithOutcome, withCasRetry } from '../catalog/cas';
import { deleteByPrefix } from '../catalog/storage';
import { loadProjectCatalogPatch, projectCatalogPatch } from './catalogProjection';
import { createListFilter } from './listFilters';
import type { ListFilters } from './listFilters';

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

export interface UpdatedMemberMutationResult extends ExistingMemberMutationResult {
	member: ProjectMember;
}

export interface ProjectDeleteMutationResult {
	project: Project;
	mutationId: SnapshotId;
}

export type InviteIdentityResolver = (
	emails: readonly string[],
) => Promise<ReadonlyMap<string, { id: UserId }>>;

export interface ClaimedInviteRows {
	members: readonly ProjectMember[];
	claimedRows: number;
	userIdsByEmail: ReadonlyMap<string, UserId>;
}

const EMPTY_EMAIL_CLAIMS: ReadonlyMap<string, UserId> = new Map();

function hasInviteRows(members: readonly ProjectMember[]): boolean {
	return members.some((member) => member.email !== undefined);
}

function noInviteClaims(members: readonly ProjectMember[]): ClaimedInviteRows {
	return { members, claimedRows: 0, userIdsByEmail: EMPTY_EMAIL_CLAIMS };
}

function higherRole(a: Role, b: Role): Role {
	return roleAtLeast(a, b) ? a : b;
}

function selectorAfterClaims(member: ProjectMember, claimed: ClaimedInviteRows): string {
	if (member.user_id !== undefined) return member.user_id;
	const email = member.email as string;
	return claimed.userIdsByEmail.get(normalizeEmail(email)) ?? email;
}

function sameValues(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

async function resolveInviteRows(
	members: readonly ProjectMember[],
	resolveIdentitiesByEmail: InviteIdentityResolver,
): Promise<ClaimedInviteRows> {
	const emails = [
		...new Set(
			members.flatMap((member) =>
				member.email === undefined ? [] : [normalizeEmail(member.email)],
			),
		),
	];
	const resolved = await resolveIdentitiesByEmail(emails);
	const userIdsByEmail = new Map<string, UserId>();
	for (const email of emails) {
		const identity = resolved.get(email);
		if (identity !== undefined) userIdsByEmail.set(email, identity.id);
	}

	const directUserIds = new Set(
		members.flatMap((member) => (member.user_id === undefined ? [] : [member.user_id])),
	);
	const output: ProjectMember[] = [];
	const outputIndexByUserId = new Map<UserId, number>();
	const pendingRoles = new Map<UserId, Role>();
	let claimedRows = 0;

	for (const member of members) {
		if (member.user_id !== undefined) {
			const pendingRole = pendingRoles.get(member.user_id);
			const index = output.length;
			output.push({
				user_id: member.user_id,
				role: pendingRole ? higherRole(member.role, pendingRole) : member.role,
			});
			if (!outputIndexByUserId.has(member.user_id)) outputIndexByUserId.set(member.user_id, index);
			pendingRoles.delete(member.user_id);
			continue;
		}

		const email = normalizeEmail(member.email as string);
		const userId = userIdsByEmail.get(email);
		if (userId === undefined) {
			output.push(member);
			continue;
		}

		claimedRows++;
		const existingIndex = outputIndexByUserId.get(userId);
		if (existingIndex !== undefined) {
			const existing = output[existingIndex];
			output[existingIndex] = { user_id: userId, role: higherRole(existing.role, member.role) };
		} else if (directUserIds.has(userId)) {
			const pendingRole = pendingRoles.get(userId);
			pendingRoles.set(userId, pendingRole ? higherRole(pendingRole, member.role) : member.role);
		} else {
			outputIndexByUserId.set(userId, output.length);
			output.push({ user_id: userId, role: member.role });
		}
	}

	return { members: output, claimedRows, userIdsByEmail };
}

export async function claimInviteRows(
	members: readonly ProjectMember[],
	resolveIdentitiesByEmail: InviteIdentityResolver,
): Promise<ClaimedInviteRows> {
	return hasInviteRows(members)
		? resolveInviteRows(members, resolveIdentitiesByEmail)
		: noInviteClaims(members);
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
		private resolveIdentitiesByEmail: InviteIdentityResolver = async () => new Map(),
	) {}

	/**
	 * List projects, newest-first paging applied by the caller. Soft-deleted
	 * projects are hidden unless explicitly requested by status. When `filter` is
	 * passed with a null/undefined `policy.defaultRole` (deployment
	 * `MARIMOHUB_DEFAULT_ROLE=none`), the list
	 * is restricted to projects the caller can see (owner or member); with a
	 * `defaultRole` set — or when the caller is a super admin — every project
	 * is visible, so nothing is hidden.
	 */
	async listProjects(
		filter?: ListFilters<Project['status']> & {
			subject: AuthorizationSubject;
			policy?: AuthorizationPolicy;
			resourceSecurity?: ResourceSecurityPolicy;
		},
	): Promise<PublicProjectEntry[]> {
		const authz = filter
			? new AuthorizationService(filter.policy, filter.resourceSecurity)
			: undefined;
		if (filter && authz && !authz.credentialAllowsAction(filter.subject, 'project.read')) {
			throw new ForbiddenError('Token grant does not permit project listing');
		}
		const snapshot = await this.catalog.getCurrentSnapshot();
		let matching = snapshot.projects.filter(
			createListFilter<SnapshotProjectEntry>(
				filter,
				(project) => [project.name, project.description],
				{ allowUnknownTags: true },
			),
		);
		if (filter?.tag !== undefined) {
			const tag = filter.tag;
			const tagMatches = await mapWithConcurrency(
				matching,
				BUCKET_SCAN_CONCURRENCY,
				async (project) =>
					project.tags?.includes(tag) ?? (await this.getProject(project.id)).tags.includes(tag),
			);
			matching = matching.filter((_, index) => tagMatches[index]);
		}
		if (!filter || !authz) return matching.map(toPublicProjectEntry);
		// Visibility routes through the authorization service so listings and
		// direct reads cannot drift. Both filters run BEFORE pagination (the
		// caller pages the returned entries), so a hidden project never leaks
		// through page counts or cursors.
		let visible = matching;
		if (!authz.listsAllProjects(filter.subject)) {
			const visibility = await mapWithConcurrency(
				matching,
				BUCKET_SCAN_CONCURRENCY,
				async (entry) => {
					const seen = authz.projectEntryVisibility(filter.subject, entry);
					// `null` = the entry predates `member_ids`, so visibility can't be decided
					// from the snapshot alone; fall back to the authoritative project.json.
					return seen ?? (await this.canSeeProject(authz, entry.id, filter.subject));
				},
			);
			visible = matching.filter((_, i) => visibility[i]);
		}
		return (
			await filterByLabelConstraints(
				authz,
				filter.subject,
				visible,
				async (entry) => (await this.getProject(entry.id)).security_labels ?? null,
			)
		).map(toPublicProjectEntry);
	}

	// Only reached when the fast path above didn't return, i.e. the caller is
	// neither a super admin nor covered by a defaultRole. Membership alone
	// decides — NOT a `project.read` decision, whose lifecycle rule would hide a
	// legacy (indeterminate) entry from an explicit `status: 'deleted'` listing
	// while current snapshot entries still appear. Lifecycle filtering already
	// happened in the status filter above, identically for both paths.
	private async canSeeProject(
		authz: AuthorizationService,
		id: ProjectId,
		subject: AuthorizationSubject,
	): Promise<boolean> {
		const project = await this.getProject(id);
		return (
			authz.projectEntryVisibility(subject, {
				id,
				owner: project.owner,
				member_ids: project.members.flatMap((member) =>
					member.user_id === undefined ? [] : [member.user_id],
				),
				member_emails: project.members.flatMap((member) =>
					member.email === undefined ? [] : [normalizeEmail(member.email)],
				),
			}) === true
		);
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
								tags: project.tags,
								member_ids: project.members.flatMap((m) =>
									m.user_id !== undefined ? [m.user_id] : [],
								),
								member_emails: [],
								security_labels: null,
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
	 * Set or clear the project's security labels (`labels: undefined` clears).
	 *
	 * The authoritative record and the snapshot projection cannot be written
	 * atomically, so the flow fails closed by ordering: (1) park the projection
	 * at INDETERMINATE (list decisions then defer to the authoritative record),
	 * (2) write the authoritative `project.json`, (3) write the final
	 * projection. A crash between any two steps leaves the projection
	 * indeterminate, never wrong — and every routine projection write
	 * (`projectCatalogPatch`) self-heals it afterwards. The two snapshot commits
	 * produce the durable audit trail: `project.security_labels.pending` and
	 * `project.security_labels` (with the old and new labels in its context).
	 */
	async setSecurityLabels(
		id: ProjectId,
		labels: ResourceSecurityLabels | undefined,
		actor: UserId,
		expectedVersion?: string,
	): Promise<Project> {
		const key = paths.project(id).meta;
		const normalized = labels === undefined ? undefined : normalizeSecurityLabels(labels);
		// A stale precondition is checked BEFORE parking the projection so a
		// rejected request never leaves the entry indeterminate; the CAS callback
		// repeats the authoritative check.
		if (expectedVersion !== undefined) {
			assertVersionMatch((await this.getProject(id)).updated_at, expectedVersion);
		}

		// Park the projection at indeterminate AND mark the mutation in flight:
		// the marker keeps concurrent routine projections from resurrecting the
		// pre-mutation labels before finalization clears it.
		await this.catalog.updateProjectEntry(
			'project.security_labels.pending',
			actor,
			id,
			() => ({ security_labels: undefined, security_labels_pending: true }),
			{ project_id: id },
		);

		let previous: ResourceSecurityLabels | null = null;
		let updated: Project;
		try {
			updated = await mutateObject(
				this.bucket,
				key,
				(raw) => parseStored(ProjectSchema, raw, key),
				(current) => {
					assertVersionMatch(current.updated_at, expectedVersion);
					if (current.status === 'deleted') {
						throw new NotFoundError(`Project ${id} not found`);
					}
					previous = current.security_labels ?? null;
					const { security_labels: _cleared, ...rest } = current;
					return {
						...rest,
						...(normalized !== undefined ? { security_labels: normalized } : {}),
						updated_at: new Date().toISOString(),
					};
				},
				{ notFound: () => new NotFoundError(`Project ${id} not found`) },
			);
		} catch (err) {
			// These are thrown by the callback BEFORE the conditional put (a lost
			// CAS is retried, and a failed put surfaces as its own error), so the
			// authoritative record is untouched and the parked projection can be
			// re-derived from it. Any other failure is ambiguous — the put may have
			// committed — and must leave the projection indeterminate.
			if (err instanceof PreconditionFailedError || err instanceof NotFoundError) {
				await this.unparkSecurityLabels(id, actor);
			}
			throw err;
		}

		await this.catalog.updateProjectEntry(
			'project.security_labels',
			actor,
			id,
			(entry) => loadProjectCatalogPatch(this.bucket, id, entry, { finalizeSecurityLabels: true }),
			{
				project_id: id,
				previous_labels: previous,
				next_labels: normalized ?? null,
			},
		);

		return updated;
	}

	/**
	 * Restore a determinate projection after a label mutation was rejected
	 * between parking and its authoritative write. Re-projecting the record
	 * (rather than restoring the labels captured at park time) stays correct
	 * when the rejection was caused by another label mutation that has already
	 * committed its record but not yet finalized. A failed rollback is logged,
	 * not raised: the projection is merely still indeterminate, and the caller
	 * must see the original rejection.
	 */
	private async unparkSecurityLabels(id: ProjectId, actor: UserId): Promise<void> {
		try {
			await this.catalog.updateProjectEntry(
				'project.security_labels.rollback',
				actor,
				id,
				(entry) =>
					loadProjectCatalogPatch(this.bucket, id, entry, { finalizeSecurityLabels: true }),
				{ project_id: id },
			);
		} catch (err) {
			logOperationalError(
				'security_labels_rollback_failed',
				{ operation: 'project.security_labels.rollback', project_id: id },
				err,
			);
		}
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
		const { project, mutationId } = await this.writeMembers(
			id,
			(_current, claimed) => {
				const claimedUserId =
					userId ?? (email === undefined ? undefined : claimed.userIdsByEmail.get(email));
				const duplicate = claimed.members.some(
					(m) =>
						(claimedUserId !== undefined && m.user_id === claimedUserId) ||
						(email !== undefined && m.email === email),
				);
				if (duplicate) {
					throw new ConflictError(`${userId ?? email} is already a member of project ${id}`);
				}
				const row: ProjectMember =
					userId !== undefined ? { user_id: userId, role } : { email: email as string, role };
				return [...claimed.members, row];
			},
			actor,
		);
		return { project, mutationId };
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
	): Promise<UpdatedMemberMutationResult> {
		let previousMember: ProjectMember | undefined;
		let member: ProjectMember | undefined;
		const { project, mutationId } = await this.writeMembers(
			id,
			(current, claimed) => {
				if (selector === current.owner) {
					throw new ConflictError(`Cannot change the role of the project owner`);
				}
				previousMember = current.members.find((m) => memberRefMatchesSelector(m, selector));
				if (!previousMember) {
					throw new NotFoundError(`${selector} is not a member of project ${id}`);
				}
				const claimedSelector = selectorAfterClaims(previousMember, claimed);
				const members = claimed.members.map((m) =>
					memberRefMatchesSelector(m, claimedSelector) ? { ...m, role } : m,
				);
				member = members.find((candidate) => memberRefMatchesSelector(candidate, claimedSelector));
				return members;
			},
			actor,
		);
		return { project, mutationId, previousMember: previousMember!, member: member! };
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
			(current, claimed) => {
				if (selector === current.owner) {
					throw new ConflictError(`Cannot remove the project owner`);
				}
				previousMember = current.members.find((m) => memberRefMatchesSelector(m, selector));
				if (!previousMember) {
					throw new NotFoundError(`${selector} is not a member of project ${id}`);
				}
				const claimedSelector = selectorAfterClaims(previousMember, claimed);
				return claimed.members.filter((m) => !memberRefMatchesSelector(m, claimedSelector));
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
		deriveMembers: (current: Project, claimed: ClaimedInviteRows) => ProjectMember[],
		actor: UserId,
	): Promise<MemberMutationResult> {
		const { project: updated } = await this.mutateMemberObject(id, deriveMembers);
		const snapshot = await this.catalog.updateProjectEntry('project.members', actor, id, (entry) =>
			loadProjectCatalogPatch(this.bucket, id, entry),
		);
		return { project: updated, mutationId: snapshot.snapshot_id };
	}

	private async mutateMemberObject(
		id: ProjectId,
		deriveMembers: (current: Project, claimed: ClaimedInviteRows) => ProjectMember[],
		options: {
			skipIfNoClaims?: boolean;
			resolveIdentitiesByEmail?: InviteIdentityResolver;
		} = {},
	): Promise<{ project: Project; claimedRows: number; written: boolean }> {
		const key = paths.project(id).meta;
		return withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			if (!object) throw new NotFoundError(`Project ${id} not found`);
			const current = await readStored(ProjectSchema, object, key);
			if (current.status === 'deleted') throw new NotFoundError(`Project ${id} not found`);
			const claimed = hasInviteRows(current.members)
				? await resolveInviteRows(
						current.members,
						options.resolveIdentitiesByEmail ?? this.resolveIdentitiesByEmail,
					)
				: noInviteClaims(current.members);
			if (options.skipIfNoClaims && claimed.claimedRows === 0) {
				return { project: current, claimedRows: 0, written: false };
			}
			const updated = {
				...current,
				members: deriveMembers(current, claimed),
				updated_at: new Date().toISOString(),
			};
			await cas.put(key, JSON.stringify(updated), { onlyIfEtagMatches: object.etag });
			return { project: updated, claimedRows: claimed.claimedRows, written: true };
		});
	}

	private async claimProjectInvites(
		candidate: SnapshotProjectEntry,
		resolveIdentitiesByEmail: InviteIdentityResolver,
	): Promise<number> {
		try {
			const result = await this.mutateMemberObject(
				candidate.id,
				(_current, claimed) => [...claimed.members],
				{
					skipIfNoClaims: true,
					resolveIdentitiesByEmail,
				},
			);
			const projection = projectCatalogPatch(result.project, candidate);
			const projectionIsCurrent =
				sameValues(candidate.member_ids, projection.member_ids) &&
				sameValues(candidate.member_emails, projection.member_emails);
			if (!result.written && projectionIsCurrent) return 0;
			await this.catalog.updateProjectEntry(
				result.written ? 'project.members.claim' : 'project.members.repair',
				SYSTEM_ACTOR,
				candidate.id,
				(entry) => loadProjectCatalogPatch(this.bucket, candidate.id, entry),
			);
			return result.claimedRows;
		} catch (error) {
			if (error instanceof NotFoundError) return 0;
			throw error;
		}
	}

	async claimPendingInvites(): Promise<number> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const candidates = snapshot.projects.filter(
			(project) => project.status !== 'deleted' && (project.member_emails?.length ?? 0) > 0,
		);
		if (candidates.length === 0) return 0;
		const candidateEmails = [
			...new Set(candidates.flatMap((project) => project.member_emails ?? []).map(normalizeEmail)),
		];
		const resolved = await this.resolveIdentitiesByEmail(candidateEmails);
		const resolveFromSweep: InviteIdentityResolver = async () => resolved;
		const claimed = await mapWithConcurrency(candidates, BUCKET_SCAN_CONCURRENCY, (project) =>
			this.claimProjectInvites(project, resolveFromSweep),
		);
		return claimed.reduce((total, count) => total + count, 0);
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
		await deleteByPrefix(this.bucket, paths.versionPruneCutoffsForProject(id));
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
