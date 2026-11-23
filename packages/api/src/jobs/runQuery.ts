import { isTerminalRunStatus } from '@marimo-hub/core/jobs';
import { z } from '@hono/zod-openapi';
import { BadRequestError, RunId, RUN_STATUSES } from '@marimo-hub/core';
import type { JobRun } from '@marimo-hub/core';
import {
	PaginationQuery,
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	decodeCursor,
	encodeCursor,
} from '../pagination';

const RunFilterFields = {
	status: z
		.enum([...RUN_STATUSES, 'active'])
		.optional()
		.openapi({
			description: 'Exact status, or active for queued, provisioning, and running.',
		}),
	triggered_by: z.string().min(1).max(1024).optional().openapi({
		description: 'Exact triggering user ID.',
	}),
};

export const RunListOptionsSchema = z
	.object({
		limit: z.number().int().positive().optional(),
		cursor: z.string().optional(),
		...RunFilterFields,
		triggered_by_me: z.boolean().optional(),
	})
	.refine((options) => !options.triggered_by_me || options.triggered_by === undefined, {
		message: 'triggered_by and triggered_by_me cannot be combined',
	});

export type RunListOptions = z.infer<typeof RunListOptionsSchema>;

export const RunListQuery = PaginationQuery.extend({
	...RunFilterFields,
	triggered_by_me: z
		.enum(['true'])
		.transform(() => true)
		.optional()
		.openapi({
			description: 'Filter to the authenticated user. Cannot be combined with triggered_by.',
		}),
}).refine((query) => query.triggered_by === undefined || query.triggered_by_me === undefined, {
	message: 'triggered_by and triggered_by_me cannot be combined',
});

export const RUN_LIST_DESCRIPTION =
	'Runs are ordered by descending run ID. Project lists and filtered job lists scan at most limit entries (maximum 500). Follow next_cursor even on empty pages. Status and access are read live. Restart from the first page to refresh active runs.';

export function prepareRunListQuery(
	query: RunListOptions,
	userId: string,
	resource: readonly unknown[],
	options: { legacyJobCursor?: boolean } = {},
) {
	const filter = {
		status: query.status,
		triggered_by: query.triggered_by_me ? userId : query.triggered_by,
	};
	const filtered = filter.status !== undefined || filter.triggered_by !== undefined;
	// Unfiltered callers retain their existing project or job cursor format.
	const scope =
		!filtered && options.legacyJobCursor
			? undefined
			: encodeURIComponent(JSON.stringify(filtered ? [...resource, filter] : resource));
	const cursor = decodeCursor(query.cursor);
	if (cursor && (!RunId.is(cursor[1]) || cursor[0] !== (scope ?? cursor[1])))
		throw new BadRequestError('Invalid pagination cursor');
	return {
		filter,
		filtered,
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		afterRunId: cursor ? RunId.parse(cursor[1]) : undefined,
		nextCursor: (runId: RunId | null) => (runId ? encodeCursor(scope ?? runId, runId) : null),
	};
}

export function matchesRunFilter(
	run: Pick<JobRun, 'status' | 'triggered_by'>,
	filter: ReturnType<typeof prepareRunListQuery>['filter'],
): boolean {
	return (
		(filter.status === undefined ||
			(filter.status === 'active'
				? !isTerminalRunStatus(run.status)
				: run.status === filter.status)) &&
		(filter.triggered_by === undefined || run.triggered_by === filter.triggered_by)
	);
}
