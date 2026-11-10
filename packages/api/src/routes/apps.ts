import { createRoute, z } from '@hono/zod-openapi';
import {
	NotFoundError,
	ProjectId,
	ROLES,
	mapWithConcurrency,
	BUCKET_SCAN_CONCURRENCY,
} from '@marimo-hub/core';
import {
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	loadAppProject,
	loadAuthorizedNotebookMeta,
	NotebookIdParam,
} from '../shared';
import {
	PaginationQuery,
	encodeCursor,
	pageSchema,
	decodeCursor,
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
} from '../pagination';
import type { ApiDeps } from '../context';
import type { AuthUser, Project, NotebookId, ResourceSecurityLabels } from '@marimo-hub/core';

const AppProjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	your_role: z.enum(ROLES).nullable(),
});

export const AppSummarySchema = z
	.object({
		project_id: z.string(),
		project_name: z.string(),
		notebook_id: z.string(),
		title: z.string(),
		url: z.string(),
		your_role: z.enum(ROLES).nullable(),
		can: z.object({ run: z.boolean() }),
	})
	.openapi('NotebookApp');

export async function appSummary(
	deps: ApiDeps,
	user: AuthUser,
	project: Project,
	notebook: { id: NotebookId; title: string },
	notebookLabels: ResourceSecurityLabels | null,
) {
	const { role, allowed } = await authorizationService(deps).authorize(user, 'session.start', {
		kind: 'session-start',
		project,
		mode: 'app',
		notebookLabels,
	});
	return {
		project_id: project.id,
		project_name: project.name,
		notebook_id: notebook.id,
		title: notebook.title,
		url: `/projects/${project.id}/notebooks/${notebook.id}/app`,
		your_role: role,
		can: { run: allowed },
	};
}

const app = createApp();
app.openapi(
	createRoute({
		method: 'get',
		path: '/apps',
		operationId: 'apps.list',
		tags: ['Apps'],
		summary: 'List accessible notebook apps',
		request: {
			query: PaginationQuery.extend({
				q: z.string().optional(),
				project_id: z.string().regex(ProjectId.regex).transform(ProjectId.parse).optional(),
			}),
		},
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: pageSchema(AppSummarySchema, 'NotebookAppPage').extend({
						project: AppProjectSchema.optional(),
					}),
				}),
				'Apps',
			),
			...commonErrors(),
			...errorResponses(403, 404),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const query = c.req.valid('query');
		const search = query.q?.toLocaleLowerCase();
		const after = decodeCursor(query.cursor);
		const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
		const selectedProject = query.project_id
			? await loadAppProject(deps.services.projects, query.project_id, user, deps)
			: undefined;
		// A selected project needs no deployment-wide discovery.
		const listed = selectedProject
			? []
			: await deps.services.projects.listProjects({
					subject: user,
					policy: deps.policy,
					resourceSecurity: deps.resourceSecurity,
					action: 'app.read',
					status: 'active',
				});
		const snapshot = await deps.services.catalog.getCurrentSnapshot();
		// Both scoped and unscoped lists use the snapshot's active status.
		const projectIds = selectedProject
			? snapshot.projects.some((p) => p.id === selectedProject.id && p.status === 'active')
				? [selectedProject.id]
				: []
			: listed.map((entry) => entry.id);
		const projectCandidates = await mapWithConcurrency(
			projectIds,
			BUCKET_SCAN_CONCURRENCY,
			async (id) => {
				try {
					const project =
						selectedProject ?? (await loadAppProject(deps.services.projects, id, user, deps));
					// Page reads check labels and deletions because the snapshot can lag metadata.
					const notebooks = await deps.services.notebooks.listNotebooks(
						project.id,
						undefined,
						snapshot,
					);
					return notebooks
						.filter(
							(notebook) =>
								!search || `${project.name} ${notebook.title}`.toLocaleLowerCase().includes(search),
						)
						.map((notebook) => ({ project, notebook }));
				} catch (error) {
					if (error instanceof NotFoundError) return [];
					throw error;
				}
			},
		);
		const candidates = projectCandidates
			.flat()
			.filter(({ project, notebook }) => {
				if (!after) return true;
				const byProject = project.id.localeCompare(after[0]);
				return byProject !== 0 ? byProject < 0 : notebook.id.localeCompare(after[1]) < 0;
			})
			.sort(
				(a, b) =>
					b.project.id.localeCompare(a.project.id) || b.notebook.id.localeCompare(a.notebook.id),
			);
		const authz = authorizationService(deps);
		const apps: Awaited<ReturnType<typeof appSummary>>[] = [];
		// A next_cursor requires one extra visible item, after deletion and label checks.
		for (let offset = 0; offset < candidates.length && apps.length <= limit; ) {
			const batch = candidates.slice(offset, offset + limit + 1 - apps.length);
			offset += batch.length;
			const resolved = await mapWithConcurrency(
				batch,
				BUCKET_SCAN_CONCURRENCY,
				async (candidate) => {
					try {
						const labels = await deps.services.notebooks.getSecurityLabels(
							candidate.project.id,
							candidate.notebook.id,
							{ consistency: 'validated' },
						);
						return { ...candidate, labels };
					} catch (error) {
						if (error instanceof NotFoundError) return null;
						throw error;
					}
				},
			);
			const readable = resolved.filter((item) => item !== null);
			const visible = await authz.projectLabelConstraints(
				user,
				readable.map((item) => item.labels),
				'app.read',
			);
			apps.push(
				...(await mapWithConcurrency(
					readable.filter((_, index) => visible[index]),
					BUCKET_SCAN_CONCURRENCY,
					({ project, notebook, labels }) => appSummary(deps, user, project, notebook, labels),
				)),
			);
		}
		const last = apps[limit - 1];
		return c.json(
			{
				success: true as const,
				data: {
					items: apps.slice(0, limit),
					next_cursor:
						apps.length > limit && last ? encodeCursor(last.project_id, last.notebook_id) : null,
					...(selectedProject
						? {
								project: {
									id: selectedProject.id,
									name: selectedProject.name,
									your_role: authz.role(user, selectedProject),
								},
							}
						: {}),
				},
			},
			200,
		);
	},
);

app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/notebooks/{nid}/app',
		operationId: 'apps.get',
		tags: ['Apps'],
		summary: 'Get notebook app details',
		request: { params: NotebookIdParam },
		responses: {
			200: jsonContent(z.object({ success: z.literal(true), data: AppSummarySchema }), 'App'),
			...commonErrors(),
			...errorResponses(404),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, nid } = c.req.valid('param');
		const project = await loadAppProject(deps.services.projects, pid, user, deps);
		const meta = await loadAuthorizedNotebookMeta(deps, project, nid, user, 'app.read');
		return c.json(
			{
				success: true as const,
				data: await appSummary(deps, user, project, meta, meta.security_labels ?? null),
			},
			200,
		);
	},
);
export default app;
