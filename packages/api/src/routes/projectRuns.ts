import { RunListQuery, resolveRunFilter, matchesRunFilter } from '../jobs/runQuery';
import { createRoute, z } from '@hono/zod-openapi';
import {
	BadRequestError,
	ForbiddenError,
	NotFoundError,
	RunId,
	RunTagKeySchema,
	RunTagValueSchema,
	mapWithConcurrency,
} from '@marimo-hub/core';
import { requireJobs, visibleJobRun, loadAuthorizedJob } from '../jobs/operations';
import { JobRunResponseSchema } from '../jobs/schemas';
import { DEFAULT_PAGE_SIZE, decodeCursor, encodeCursor, pageSchema } from '../pagination';
import {
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	loadSessionProject,
	ProjectIdParam,
} from '../shared';

const ProjectRunQuery = RunListQuery.extend({
	tag_key: RunTagKeySchema.optional(),
	tag_value: RunTagValueSchema.optional(),
})
	.strict()
	.refine((query) => (query.tag_key === undefined) === (query.tag_value === undefined), {
		message: 'tag_key and tag_value must be supplied together',
	});

function afterRun(cursor: string | undefined, scope: string): RunId | undefined {
	const decoded = decodeCursor(cursor);
	if (!decoded) return;
	if (decoded[0] !== scope || !RunId.is(decoded[1]))
		throw new BadRequestError('Invalid pagination cursor');
	return RunId.parse(decoded[1]);
}

const app = createApp();
app.openapi(
	createRoute({
		method: 'get',
		path: '/projects/{pid}/runs',
		operationId: 'projects.runs.list',
		tags: ['Jobs'],
		summary: 'List project runs with an optional exact-match submission tag',
		description:
			'Scans at most limit index entries (maximum 500), newest run ID first. Empty filtered pages can have a continuation cursor. Tags are conventions, never authorization: each result requires current source job access.',
		request: { params: ProjectIdParam, query: ProjectRunQuery },
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
		const filter = resolveRunFilter(query, c.get('user').id);
		const filtered = filter.status !== undefined || filter.triggered_by !== undefined;
		const scope = encodeURIComponent(
			JSON.stringify(filtered ? [pid, tag ?? null, filter] : [pid, tag ?? null]),
		);
		const page = await deps.services.jobRuns.listProjectRunsPage(
			pid,
			query.limit ?? DEFAULT_PAGE_SIZE,
			afterRun(query.cursor, scope),
			tag,
		);

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
					next_cursor: page.nextRunId ? encodeCursor(scope, page.nextRunId) : null,
				},
			},
			200,
		);
	},
);

export default app;
