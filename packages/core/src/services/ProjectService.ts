import type { Bucket } from '../ports/bucket';
import { NotFoundError } from '../errors';
import { createProjectId, type ProjectId } from '../ids';
import { paths } from '../paths';
import {
	ProjectSchema,
	toPublicProjectEntry,
	type Project,
	type PublicProjectEntry,
	type Snapshot,
} from '../schema';
import type { CatalogService } from './CatalogService';
import { listAllKeys } from './storage';

export interface CreateProjectInput {
	name: string;
	description: string;
	tags?: string[];
}

export interface UpdateProjectInput {
	name?: string;
	description?: string;
	tags?: string[];
}

export class ProjectService {
	constructor(
		private bucket: Bucket,
		private catalog: CatalogService,
	) {}

	async listProjects(): Promise<PublicProjectEntry[]> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		return snapshot.projects.map(toPublicProjectEntry);
	}

	async getProject(id: ProjectId): Promise<Project> {
		const obj = await this.bucket.get(paths.project(id).meta);
		if (!obj) {
			throw new NotFoundError(`Project ${id} not found`);
		}
		return ProjectSchema.parse(await obj.json());
	}

	async createProject(input: CreateProjectInput, actor: string): Promise<Project> {
		const id = createProjectId();
		const now = new Date().toISOString();

		const project: Project = {
			schema_version: 1,
			id,
			name: input.name,
			description: input.description,
			owner: actor,
			members: [{ user_id: actor, role: 'admin' }],
			created_at: now,
			updated_at: now,
			tags: input.tags ?? [],
		};

		await this.bucket.put(paths.project(id).meta, JSON.stringify(project));

		await this.catalog.mutateSnapshot('project.create', actor, (snap: Snapshot) => ({
			...snap,
			projects: [
				...snap.projects,
				{
					id,
					name: project.name,
					description: project.description,
					owner: actor,
					created_at: now,
					updated_at: now,
					notebook_count: 0,
					notebooks: [],
				},
			],
		}));

		return project;
	}

	async updateProject(id: ProjectId, input: UpdateProjectInput, actor: string): Promise<Project> {
		const existing = await this.getProject(id);
		const now = new Date().toISOString();

		const updated: Project = {
			...existing,
			name: input.name ?? existing.name,
			description: input.description ?? existing.description,
			tags: input.tags ?? existing.tags,
			updated_at: now,
		};

		await this.bucket.put(paths.project(id).meta, JSON.stringify(updated));

		await this.catalog.mutateSnapshot('project.update', actor, (snap: Snapshot) => ({
			...snap,
			projects: snap.projects.map((p) =>
				p.id === id
					? {
							...p,
							name: updated.name,
							description: updated.description,
							updated_at: now,
						}
					: p,
			),
		}));

		return updated;
	}

	async deleteProject(id: ProjectId, actor: string): Promise<void> {
		await this.getProject(id); // ensure exists (404 otherwise)

		// Hard-delete the project's entire object subtree. `paths.project(id).meta`
		// is `projects/{id}/project.json`; every notebook file, version, README,
		// and dep for this project lives under the same `projects/{id}/` prefix, so
		// deleting that prefix reclaims the whole subtree. Derive the prefix from
		// `paths` (strip the `project.json` filename) so it stays consistent with
		// the path layout rather than hardcoding the literal here.
		const prefix = paths.project(id).meta.replace(/project\.json$/, '');
		const keys = await listAllKeys(this.bucket, prefix);
		if (keys.length > 0) {
			await this.bucket.delete(keys);
		}

		// Mutate the snapshot LAST. If the file deletes above fail and throw, the
		// catalog still points at a (now possibly partially deleted) project that
		// is safe to retry; we never leave the catalog referencing a project whose
		// snapshot entry was removed before its files were gone.
		await this.catalog.mutateSnapshot('project.delete', actor, (snap: Snapshot) => ({
			...snap,
			projects: snap.projects.filter((p) => p.id !== id),
		}));
	}
}
