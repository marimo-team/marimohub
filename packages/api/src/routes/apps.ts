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
	loadAuthorizedNotebook,
	NotebookIdParam,
} from '../shared';
import { PaginationQuery, paginate, pageSchema } from '../pagination';
import type { ApiDeps } from '../context';
import type { AuthUser, Project, NotebookId, ResourceSecurityLabels } from '@marimo-hub/core';

const AppProjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	your_role: z.enum(ROLES).nullable(),
});

const AppSummarySchema = z
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

async function summary(
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
		const selectedProject = query.project_id
			? await loadAppProject(deps.services.projects, query.project_id, user, deps)
			: undefined;
		const projects = await deps.services.projects.listProjects({
			subject: user,
			policy: deps.policy,
			resourceSecurity: deps.resourceSecurity,
			action: 'app.read',
			status: 'active',
		});
		const groups = await mapWithConcurrency(
			projects.filter((p) => !query.project_id || p.id === query.project_id),
			BUCKET_SCAN_CONCURRENCY,
			async (entry) => {
				try {
					const project = await loadAppProject(deps.services.projects, entry.id, user, deps);
					const notebooks = await deps.services.notebooks.listNotebooks(project.id, {
						subject: user,
						policy: deps.policy,
						resourceSecurity: deps.resourceSecurity,
						action: 'app.read',
					});
					const matching = notebooks.filter(
						(notebook) =>
							!query.q ||
							`${project.name} ${notebook.title}`
								.toLocaleLowerCase()
								.includes(query.q.toLocaleLowerCase()),
					);
					return await mapWithConcurrency(matching, BUCKET_SCAN_CONCURRENCY, async (notebook) =>
						summary(
							deps,
							user,
							project,
							notebook,
							await deps.services.notebooks.getSecurityLabels(project.id, notebook.id),
						),
					);
				} catch (error) {
					if (error instanceof NotFoundError) return [];
					throw error;
				}
			},
		);
		return c.json(
			{
				success: true as const,
				data: {
					...paginate(groups.flat(), query, {
						key: (item) => item.project_id,
						tiebreak: (item) => item.notebook_id,
					}),
					...(selectedProject
						? {
								project: {
									id: selectedProject.id,
									name: selectedProject.name,
									your_role: authorizationService(deps).role(user, selectedProject),
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
		const { meta } = await loadAuthorizedNotebook(deps, project, nid, user, 'app.read');
		return c.json(
			{
				success: true as const,
				data: await summary(deps, user, project, meta, meta.security_labels ?? null),
			},
			200,
		);
	},
);
export default app;
