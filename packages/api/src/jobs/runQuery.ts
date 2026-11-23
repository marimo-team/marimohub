import { z } from '@hono/zod-openapi';
import { RUN_STATUSES } from '@marimo-hub/core';
import type { JobRun } from '@marimo-hub/core';
import { PaginationQuery } from '../pagination';

export const RunListQuery = PaginationQuery.extend({
	status: z
		.enum([...RUN_STATUSES, 'active'])
		.optional()
		.openapi({
			description: 'Exact status, or active for queued, provisioning, and running.',
		}),
	triggered_by: z.string().min(1).max(1024).optional().openapi({
		description: 'Exact triggering user ID, or me for the authenticated user.',
	}),
});

export function resolveRunFilter(query: z.infer<typeof RunListQuery>, userId: string) {
	return {
		status: query.status,
		triggered_by: query.triggered_by === 'me' ? userId : query.triggered_by,
	};
}

export function matchesRunFilter(
	run: Pick<JobRun, 'status' | 'triggered_by'>,
	filter: ReturnType<typeof resolveRunFilter>,
): boolean {
	return (
		(filter.status === undefined ||
			(filter.status === 'active'
				? ['queued', 'provisioning', 'running'].includes(run.status)
				: run.status === filter.status)) &&
		(filter.triggered_by === undefined || run.triggered_by === filter.triggered_by)
	);
}
