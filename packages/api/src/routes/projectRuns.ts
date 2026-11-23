import {
	RunListQuery,
	prepareRunListQuery,
	matchesRunFilter,
	RUN_LIST_DESCRIPTION,
} from '../jobs/runQuery';
import { createRoute, z } from '@hono/zod-openapi';
import {
	ForbiddenError,
	NotFoundError,
	RunTagKeySchema,
	RunTagValueSchema,
	mapWithConcurrency,
} from '@marimo-hub/core';
import { requireJobs, visibleJobRun, loadAuthorizedJob } from '../jobs/operations';
import { JobRunResponseSchema } from '../jobs/schemas';
import { pageSchema } from '../pagination';
import {
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	loadSessionProject,
	ProjectIdParam,
} from '../shared';

const ProjectRunListQuery = RunListQuery.safeExtend({
	tag_key: RunTagKeySchema.optional(),
	tag_value: RunTagValueSchema.optional(),
})
	.strict()
	.refine((query) => (query.tag_key === undefined) === (query.tag_value === undefined), {
		message: 'tag_key and tag_value must be supplied together',
	});

const app = createApp();
app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/runs',
		operationId: 'projects.runs.list',
		tags: ['Jobs'],
		summary: 'List project runs by status, triggering user, or submission tag',
		description: RUN_LIST_DESCRIPTION,
		request: { params: ProjectIdParam, query: ProjectRunListQuery },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: pageSchema(JobRunResponseSchema, 'ProjectRunPage'),
				}),
				'Authorized run history',
			),
			...commonErrors(),
			...errorResponses(400, 403, 404),
		},
	}),
	async (c) => {
		const deps = c.get('deps');
		requireJobs(deps);
		const { pid } = c.req.valid('param');
		await loadSessionProject(deps.services.projects, pid, c.get('user'), deps);
		const query = c.req.valid('query');
		const tag =
			query.tag_key === undefined ? undefined : { key: query.tag_key, value: query.tag_value! };
		const { filter, limit, afterRunId, nextCursor } = prepareRunListQuery(query, c.get('user').id, [
			pid,
			tag ?? null,
		]);
		const page = await deps.services.jobRuns.listProjectRunsPage(pid, limit, afterRunId, tag);

		const targets = new Map<string, ReturnType<typeof loadAuthorizedJob>>();
		const visible = await mapWithConcurrency(page.items, 16, async (run) => {
			try {
				const key = `${run.notebook_id}/${run.job_id}`;
				let pending = targets.get(key);
				if (!pending) {
					pending = loadAuthorizedJob(deps, c.get('user'), pid, run.notebook_id, run.job_id);
					targets.set(key, pending);
				}
				const target = await pending;
				return await visibleJobRun(deps, target, target.job, run);
			} catch (error) {
				if (error instanceof NotFoundError || error instanceof ForbiddenError) return null;
				throw error;
			}
		});

		return c.json(
			{
				success: true as const,
				data: {
					items: visible
						.filter((run) => run !== null)
						.filter((run) => matchesRunFilter(run, filter)),
					next_cursor: nextCursor(page.nextRunId),
				},
			},
			200,
		);
	},
);

export default app;
