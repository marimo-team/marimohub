import { createRoute, z } from '@hono/zod-openapi';
import {
	BadRequestError,
	ForbiddenError,
	NotFoundError,
	RunId,
	RunTagKeySchema,
	RunTagValueSchema,
	mapWithConcurrency,
	toPublicJobRun,
} from '@marimo-hub/core';
import { requireJobs } from '../jobs/operations';
import { JobRunResponseSchema } from '../jobs/schemas';
import { JobIdParam, loadAuthorizedJob } from './jobs';
import {
	DEFAULT_PAGE_SIZE,
	PaginationQuery,
	decodeCursor,
	encodeCursor,
	pageSchema,
} from '../pagination';
import {
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	loadVisibleProject,
	ProjectIdParam,
} from '../shared';

const ProjectRunQuery = PaginationQuery.extend({
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
		await loadVisibleProject(deps.services.projects, pid, c.get('user'), deps);
		const query = c.req.valid('query');
		const tag =
			query.tag_key === undefined ? undefined : { key: query.tag_key, value: query.tag_value! };
		const scope = encodeURIComponent(JSON.stringify([pid, tag ?? null]));
		const page = await deps.services.jobRuns.listProjectRunsPage(
			pid,
			query.limit ?? DEFAULT_PAGE_SIZE,
			afterRun(query.cursor, scope),
			tag,
		);
		const permissions = new Map<string, Promise<boolean>>();
		const visible = await mapWithConcurrency(page.items, 16, async (run) => {
			const key = `${run.notebook_id}/${run.job_id}`;
			let permission = permissions.get(key);
			if (!permission) {
				permission = loadAuthorizedJob(c, pid, run.notebook_id, run.job_id)
					.then(() => true)
					.catch((error: unknown) => {
						if (error instanceof NotFoundError || error instanceof ForbiddenError) return false;
						throw error;
					});
				permissions.set(key, permission);
			}
			return (await permission) ? toPublicJobRun(run) : null;
		});
		return c.json(
			{
				success: true as const,
				data: {
					items: visible.filter((run) => run !== null),
					next_cursor: page.nextRunId ? encodeCursor(scope, page.nextRunId) : null,
				},
			},
			200,
		);
	},
);

app.openapi(
	createRoute({
		method: 'post',
		path: '/projects/{pid}/notebooks/{nid}/jobs/{jid}/history-backfill',
		operationId: 'jobs.history.backfill',
		tags: ['Jobs'],
		summary: 'Repair one bounded page of the project run index',
		request: { params: JobIdParam, query: PaginationQuery },
		responses: {
			200: jsonContent(
				z.object({
					success: z.literal(true),
					data: z.object({ next_cursor: z.string().nullable() }),
				}),
				'Backfill progress',
			),
			...commonErrors(),
			...errorResponses(400, 403, 404),
		},
	}),
	async (c) => {
		const { pid, nid, jid } = c.req.valid('param');
		const { job } = await loadAuthorizedJob(c, pid, nid, jid, 'notebook.write');
		const query = c.req.valid('query');
		const scope = `${pid}/${nid}/${jid}`;
		const page = await c
			.get('deps')
			.services.jobRuns.backfillProjectRuns(
				job,
				query.limit ?? DEFAULT_PAGE_SIZE,
				afterRun(query.cursor, scope),
			);
		return c.json(
			{
				success: true as const,
				data: { next_cursor: page.nextRunId ? encodeCursor(scope, page.nextRunId) : null },
			},
			200,
		);
	},
);
export default app;
