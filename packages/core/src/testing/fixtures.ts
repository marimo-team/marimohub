import { MemoryBucket } from './MemoryBucket';
import {
	createNotebookId,
	createProjectId,
	createSessionId,
	createSnapshotId,
	createVersionId,
	type NotebookId,
	type ProjectId,
	type SessionId,
	type SnapshotId,
	type VersionId,
} from '../index';
import type {
	Catalog,
	NotebookMeta,
	Project,
	Session,
	Snapshot,
	SnapshotNotebookEntry,
	SnapshotProjectEntry,
	Source,
	Version,
} from '../index';
import { createServices } from '../index';

// --- Constants ---

export const ACTOR = 'user_01HXY00000000000000000000';
export const NOW = '2025-03-05T14:00:00.000Z';

// --- ID factories ---

let _ids = {
	project: null as ProjectId | null,
	notebook: null as NotebookId | null,
	snapshot: null as SnapshotId | null,
	version: null as VersionId | null,
	session: null as SessionId | null,
};

export function ids() {
	if (!_ids.project) {
		_ids = {
			project: createProjectId(),
			notebook: createNotebookId(),
			snapshot: createSnapshotId(),
			version: createVersionId(),
			session: createSessionId(),
		};
	}
	return _ids as {
		project: ProjectId;
		notebook: NotebookId;
		snapshot: SnapshotId;
		version: VersionId;
		session: SessionId;
	};
}

export function resetIds() {
	_ids = { project: null, notebook: null, snapshot: null, version: null, session: null };
}

// --- Object factories ---

export function makeProject(overrides: Partial<Project> = {}): Project {
	const id = overrides.id ?? createProjectId();
	return {
		schema_version: 1,
		id,
		name: 'Test Project',
		description: 'A test project',
		owner: ACTOR,
		members: [{ user_id: ACTOR, role: 'admin' }],
		created_at: NOW,
		updated_at: NOW,
		tags: ['test'],
		...overrides,
	};
}

export function makeSnapshotProjectEntry(
	overrides: Partial<SnapshotProjectEntry> = {},
): SnapshotProjectEntry {
	const id = overrides.id ?? createProjectId();
	return {
		id,
		name: 'Test Project',
		description: 'A test project',
		owner: ACTOR,
		created_at: NOW,
		updated_at: NOW,
		notebook_count: 0,
		notebooks: [],
		...overrides,
	};
}

export function makeNotebookMeta(overrides: Partial<NotebookMeta> = {}): NotebookMeta {
	return {
		schema_version: 1,
		id: overrides.id ?? createNotebookId(),
		project_id: overrides.project_id ?? createProjectId(),
		title: 'Test Notebook',
		description: 'A test notebook',
		status: 'active',
		author: ACTOR,
		created_at: NOW,
		updated_at: NOW,
		last_run_at: null,
		tags: ['test'],
		...overrides,
	};
}

export function makeSnapshotNotebookEntry(
	projectId: ProjectId,
	overrides: Partial<SnapshotNotebookEntry> = {},
): SnapshotNotebookEntry {
	const id = overrides.id ?? createNotebookId();
	return {
		id,
		title: 'Test Notebook',
		description: 'A test notebook',
		status: 'active',
		source_type: 'local',
		author: ACTOR,
		created_at: NOW,
		updated_at: NOW,
		tags: ['test'],
		last_run_at: null,
		key_prefix: `projects/${projectId}/notebooks/${id}`,
		...overrides,
	};
}

export function makeVersion(overrides: Partial<Version> = {}): Version {
	return {
		schema_version: 1,
		version_id: overrides.version_id ?? createVersionId(),
		notebook_id: overrides.notebook_id ?? createNotebookId(),
		saved_at: NOW,
		author: ACTOR,
		message: 'test version',
		parent_id: null,
		...overrides,
	};
}

export function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		session_id: overrides.session_id ?? createSessionId(),
		notebook_id: overrides.notebook_id ?? createNotebookId(),
		project_id: overrides.project_id ?? createProjectId(),
		user_id: ACTOR,
		status: 'running',
		started_at: NOW,
		last_heartbeat: NOW,
		...overrides,
	};
}

export function makeLocalSource(versionId?: VersionId): Source {
	return {
		schema_version: 1,
		type: 'local',
		current_version_id: versionId ?? createVersionId(),
	};
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		snapshot_id: overrides.snapshot_id ?? createSnapshotId(),
		schema_version: 1,
		created_at: NOW,
		operation: 'test',
		actor: ACTOR,
		projects: [],
		...overrides,
	};
}

export function makeCatalog(snapshotId: SnapshotId): Catalog {
	return {
		version: 1,
		updated_at: NOW,
		current_snapshot_id: snapshotId,
		current_snapshot_key: `_system/snapshots/${snapshotId}.json`,
		previous_snapshot_id: null,
	};
}

// --- Test environment factory ---

export async function setupTestEnv() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	return { bucket, ...services };
}
