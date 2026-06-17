import type { NotebookId, ProjectId, SessionId, SnapshotId, VersionId } from './ids';

export interface VersionPaths {
	code: string;
	deps: string;
	meta: string;
}

export interface NotebookPaths {
	/** Base directory: `projects/{pid}/notebooks/{nid}` */
	base: string;
	/** Inner namespace prefix: `projects/{pid}/notebooks/{nid}/notebook/` */
	prefix: string;
	meta: string;
	readme: string;
	source: string;
	code: string;
	deps: string;
	version: (vid: VersionId) => VersionPaths;
}

export interface ProjectPaths {
	meta: string;
	notebook: (nid: NotebookId) => NotebookPaths;
}

function versionPaths(base: string, vid: VersionId): VersionPaths {
	const prefix = `${base}/versions/${vid}`;
	return {
		code: `${prefix}/notebook.py`,
		deps: `${prefix}/pyproject.toml`,
		meta: `${prefix}/version.json`,
	};
}

function notebookPaths(projectBase: string, nid: NotebookId): NotebookPaths {
	const base = `${projectBase}/notebooks/${nid}`;
	const inner = `${base}/notebook`;
	return {
		base,
		prefix: `${inner}/`,
		meta: `${base}/meta.json`,
		readme: `${base}/README.md`,
		source: `${inner}/source.json`,
		code: `${inner}/notebook.py`,
		deps: `${inner}/pyproject.toml`,
		version: (vid: VersionId) => versionPaths(inner, vid),
	};
}

function projectPaths(pid: ProjectId): ProjectPaths {
	const base = `projects/${pid}`;
	return {
		meta: `${base}/project.json`,
		notebook: (nid: NotebookId) => notebookPaths(base, nid),
	};
}

export const paths = {
	catalog: '_system/catalog.json',
	snapshot: (id: SnapshotId) => `_system/snapshots/${id}.json`,
	snapshotsPrefix: '_system/snapshots/',
	session: (id: SessionId) => `_system/sessions/${id}.json`,
	sessionsPrefix: '_system/sessions/',
	eventsPrefix: '_system/events/',
	eventsForDate: (date: string) => `_system/events/${date}/`,
	event: (date: string, id: string) => `_system/events/${date}/${id}.json`,
	/** Advisory lease guarding the single-writer maintenance sweep (see MaintenanceLock). */
	maintenanceLock: '_system/_maintenance.lock',
	project: projectPaths,
} as const;
