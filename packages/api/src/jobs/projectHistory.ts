import type { z } from '@hono/zod-openapi';
import {
	ForbiddenError,
	NotFoundError,
	RunTagKeySchema,
	RunTagValueSchema,
	mapWithConcurrency,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, ProjectId } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { loadSessionProject } from '../shared';
import { requireJobs, visibleJobRun, loadAuthorizedJob } from './operations';
import { RunListQuery, prepareRunListQuery, matchesRunFilter } from './runQuery';

export const ProjectRunListQuery = RunListQuery.safeExtend({
	tag_key: RunTagKeySchema.optional(),
	tag_value: RunTagValueSchema.optional(),
})
	.strict()
	.refine((query) => (query.tag_key === undefined) === (query.tag_value === undefined), {
		message: 'tag_key and tag_value must be supplied together',
	});

export async function listProjectRunHistory(
	deps: ApiDeps,
	user: AuthenticatedPrincipal,
	pid: ProjectId,
	query: z.infer<typeof ProjectRunListQuery>,
) {
	requireJobs(deps);
	await loadSessionProject(deps.services.projects, pid, user, deps);
	const tag =
		query.tag_key === undefined ? undefined : { key: query.tag_key, value: query.tag_value! };
	const { filter, limit, afterRunId, nextCursor } = prepareRunListQuery(query, user.id, [
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
				pending = loadAuthorizedJob(deps, user, pid, run.notebook_id, run.job_id);
				targets.set(key, pending);
			}
			const target = await pending;
			return await visibleJobRun(deps, target, target.job, run);
		} catch (error) {
			if (error instanceof NotFoundError || error instanceof ForbiddenError) return null;
			throw error;
		}
	});

	return {
		items: visible.filter((run) => run !== null).filter((run) => matchesRunFilter(run, filter)),
		next_cursor: nextCursor(page.nextRunId),
	};
}
