import { LazyMap } from '../../cache';
import type { ProjectId, UserId } from '../../ids';
import { normalizeEmail } from '../../identityMatch';
import type { Bucket } from '../../ports/bucket';
import type { Catalog, Snapshot, SnapshotProjectEntry } from '../../schema';
import { EtagRecordCache } from '../../etagRecordCache';

type Subject = { id: UserId; email: string; groups?: readonly string[] };

type ProjectInvolvement = {
	userIds: Map<string, ProjectId[]>;
	emails: Map<string, ProjectId[]>;
	groups: Map<string, ProjectId[]>;
	legacy: ProjectId[];
	defaultAccess: ProjectId[];
};

const projectIndexes = new WeakMap<Snapshot, ReadonlyMap<ProjectId, SnapshotProjectEntry>>();

export function projectsById(snapshot: Snapshot): ReadonlyMap<ProjectId, SnapshotProjectEntry> {
	let index = projectIndexes.get(snapshot);
	if (!index) {
		index = new Map(snapshot.projects.map((project) => [project.id, project]));
		projectIndexes.set(snapshot, index);
	}
	return index;
}

function freeze(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}

export class SnapshotCacheEntry {
	readonly byProjectId: ReadonlyMap<ProjectId, SnapshotProjectEntry>;
	private involvement?: ProjectInvolvement;

	constructor(readonly snapshot: Snapshot) {
		const runtime = globalThis as { process?: { env?: { NODE_ENV?: string } } };
		if (runtime.process?.env?.NODE_ENV !== 'production') freeze(snapshot);
		this.byProjectId = projectsById(snapshot);
	}

	candidatesFor(subject: Subject, includeDefaultAccess = false): ReadonlySet<ProjectId> {
		const index = (this.involvement ??= this.buildInvolvement());
		return new Set([
			...index.legacy,
			...(includeDefaultAccess ? index.defaultAccess : []),
			...(index.userIds.get(subject.id) ?? []),
			...(index.emails.get(normalizeEmail(subject.email)) ?? []),
			...(subject.groups ?? []).flatMap((group) => index.groups.get(group) ?? []),
		]);
	}

	private buildInvolvement(): ProjectInvolvement {
		const index: ProjectInvolvement = {
			userIds: new Map(),
			emails: new Map(),
			groups: new Map(),
			legacy: [],
			defaultAccess: [],
		};
		const add = (map: Map<string, ProjectId[]>, key: string, id: ProjectId) => {
			const entries = map.get(key) ?? [];
			entries.push(id);
			map.set(key, entries);
		};
		for (const project of this.snapshot.projects) {
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
	readonly pointer = new EtagRecordCache<Catalog>(1);
	private readonly entries = new LazyMap<string, SnapshotCacheEntry>(
		() => {
			throw new Error('Snapshot loader required');
		},
		{ maxSize: 2 },
	);

	read(key: string, load: () => Promise<Snapshot>): Promise<SnapshotCacheEntry> {
		// Only immutable objects share in-flight loads; every pointer read reaches storage.
		return this.entries.getOrLoad(key, async () => new SnapshotCacheEntry(await load()));
	}

	set(key: string, snapshot: Snapshot): void {
		this.entries.set(key, new SnapshotCacheEntry(snapshot));
	}
}

const caches = new WeakMap<Bucket, SnapshotCache>();

export function snapshotCache(bucket: Bucket): SnapshotCache {
	let cache = caches.get(bucket);
	if (!cache) {
		cache = new SnapshotCache();
		caches.set(bucket, cache);
	}
	return cache;
}
