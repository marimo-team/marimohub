import { metrics } from '@opentelemetry/api';
import { LazyMap, weakMemo } from '../../cache';
import type { ProjectId, UserId } from '../../ids';
import { normalizeEmail } from '../../identityMatch';
import type { Bucket } from '../../ports/bucket';
import type { Catalog, Snapshot, SnapshotProjectEntry } from '../../schema';
import { EtagRecordCache } from '../../etagRecordCache';
import { effectiveRole } from '../../authz';
import type { AuthSubject, AuthzPolicy } from '../../authz';
import type { Role } from '../../constants';

type Subject = { id: UserId; email: string; groups?: readonly string[] };

type ProjectInvolvement = {
	userIds: Map<string, ProjectId[]>;
	emails: Map<string, ProjectId[]>;
	groups: Map<string, ProjectId[]>;
	legacy: ProjectId[];
	defaultAccess: ProjectId[];
	indeterminateAccess: ProjectId[];
	inheritedAccess: ProjectId[];
};

function accessProjection(
	entry: SnapshotProjectEntry,
	generation?: string,
): SnapshotProjectEntry['access'] {
	// Legacy writers cannot park access; only trust summaries from the opted-in deployment.
	if (!generation || entry.access?.generation !== generation || entry.access_pending?.length) {
		return undefined;
	}
	return entry.access;
}

export function projectedRole(
	entry: SnapshotProjectEntry,
	subject: AuthSubject,
	policy?: AuthzPolicy,
	accessGeneration?: string,
): Role | null | undefined {
	const access = accessProjection(entry, accessGeneration);
	if (access === undefined) return undefined;
	return effectiveRole(
		{
			...entry,
			...access,
			schema_version: 1,
			tags: entry.tags ?? [],
			security_labels: entry.security_labels ?? undefined,
		},
		subject,
		policy,
	);
}

export const projectsById = weakMemo(
	(snapshot: Snapshot): ReadonlyMap<ProjectId, SnapshotProjectEntry> =>
		new Map(snapshot.projects.map((project) => [project.id, project])),
);

const serializations = new WeakMap<Snapshot, string>();

/** Memoized only for frozen (cached) snapshots, whose serialization cannot change. */
export function snapshotJson(snapshot: Snapshot): string {
	let json = serializations.get(snapshot);
	if (json === undefined) {
		json = JSON.stringify(snapshot);
		if (Object.isFrozen(snapshot)) serializations.set(snapshot, json);
	}
	return json;
}

function freeze(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}

export class SnapshotCacheEntry {
	readonly byProjectId: ReadonlyMap<ProjectId, SnapshotProjectEntry>;
	private readonly involvement = new Map<string | undefined, ProjectInvolvement>();

	/** `json` must be the snapshot's exact serialization. */
	constructor(
		readonly snapshot: Snapshot,
		json?: string,
	) {
		freeze(snapshot);
		if (json !== undefined) serializations.set(snapshot, json);
		this.byProjectId = projectsById(snapshot);
	}

	candidatesFor(
		subject: Subject,
		includeDefaultAccess = false,
		accessGeneration?: string,
	): ReadonlySet<ProjectId> {
		const index = this.involvementFor(accessGeneration);
		return new Set([
			...index.legacy,
			...(includeDefaultAccess ? index.defaultAccess : []),
			...(index.userIds.get(subject.id) ?? []),
			...(index.emails.get(normalizeEmail(subject.email)) ?? []),
			...(subject.groups ?? []).flatMap((group) => index.groups.get(group) ?? []),
		]);
	}

	accessCandidatesFor(
		subject: Subject,
		hasDefaultRole: boolean,
		accessGeneration?: string,
	): ReadonlySet<ProjectId> {
		const index = this.involvementFor(accessGeneration);
		return new Set([
			...this.candidatesFor(subject, true, accessGeneration),
			...index.indeterminateAccess,
			...(hasDefaultRole ? index.inheritedAccess : []),
		]);
	}

	private involvementFor(accessGeneration?: string): ProjectInvolvement {
		let index = this.involvement.get(accessGeneration);
		if (!index) {
			index = this.buildInvolvement(accessGeneration);
			this.involvement.set(accessGeneration, index);
		}
		return index;
	}

	private buildInvolvement(accessGeneration?: string): ProjectInvolvement {
		const index: ProjectInvolvement = {
			userIds: new Map(),
			emails: new Map(),
			groups: new Map(),
			legacy: [],
			defaultAccess: [],
			indeterminateAccess: [],
			inheritedAccess: [],
		};
		const add = (map: Map<string, ProjectId[]>, key: string, id: ProjectId) => {
			const entries = map.get(key) ?? [];
			entries.push(id);
			map.set(key, entries);
		};
		for (const project of this.snapshot.projects) {
			const access = accessProjection(project, accessGeneration);
			if (access === undefined) {
				index.indeterminateAccess.push(project.id);
			}
			if (access?.default_role === 'inherit') index.inheritedAccess.push(project.id);
			// Deleted entries remain candidates for status-filtered administrative lists.
			add(index.userIds, project.owner, project.id);
			if (
				project.member_ids === undefined ||
				project.member_emails === undefined ||
				project.member_groups === undefined
			)
				index.legacy.push(project.id);
			if (project.default_role !== 'inherit' && project.default_role !== 'none') {
				index.defaultAccess.push(project.id);
			}
			for (const id of project.member_ids ?? []) add(index.userIds, id, project.id);
			for (const email of project.member_emails ?? [])
				add(index.emails, normalizeEmail(email), project.id);
			for (const group of project.member_groups ?? []) add(index.groups, group, project.id);
		}
		return index;
	}
}

class SnapshotCache {
	private readonly reads = metrics
		.getMeter('@marimo-hub/core')
		.createCounter('cache.snapshot.reads');
	readonly pointer = new EtagRecordCache<Catalog>(1);
	private readonly entries = new LazyMap<string, SnapshotCacheEntry>({ maxSize: 2 });

	read(key: string, load: () => Promise<Snapshot>): Promise<SnapshotCacheEntry> {
		const hit = this.entries.getIfPresent(key) !== undefined || this.entries.hasPending(key);
		this.reads.add(1, { result: hit ? 'hit' : 'miss' });
		// Only immutable objects share in-flight loads; every pointer read reaches storage.
		return this.entries.getOrLoad(key, async () => new SnapshotCacheEntry(await load()));
	}

	set(key: string, snapshot: Snapshot, json?: string): void {
		this.entries.set(key, new SnapshotCacheEntry(snapshot, json));
	}
}

export const snapshotCache = weakMemo((_bucket: Bucket) => new SnapshotCache());
