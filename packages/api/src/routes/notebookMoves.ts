import { createRoute, z } from '@hono/zod-openapi';
import {
	ProjectId,
	ValidationError,
	isMonotonicRestrictionIncrease,
	providerForRepo,
	toPublicNotebookMeta,
	asFilesystemSnapshots,
} from '@marimo-hub/core';
import {
	assertProjectActionOn,
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	ifMatchToken,
	jsonBody,
	jsonContent,
	NotebookIdParam,
	NotebookMetaResponseSchema,
	RequiredIdempotencyKeyHeader,
	RequiredIfMatchHeader,
} from '../shared';
import { assertPullSourceSupported } from './sourcePullSync';

const app = createApp();
const moveNotebook = createRoute({
	method: 'post',
	path: '/projects/{pid}/notebooks/{nid}/move',
	operationId: 'notebooks.move',
	tags: ['Notebooks'],
	summary: 'Move a notebook to another project',
	request: {
		params: NotebookIdParam,
		headers: RequiredIdempotencyKeyHeader.extend(RequiredIfMatchHeader.shape),
		body: jsonBody(z.object({ destination_project_id: z.string().refine(ProjectId.is) })),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: NotebookMetaResponseSchema }),
			'Notebook moved',
		),
		...commonErrors(),
		...errorResponses(403, 404, 409, 412),
	},
});

app.openapi(moveNotebook, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const destination = ProjectId.parse(c.req.valid('json').destination_project_id);
	await assertProjectRole(deps.services.projects, pid, user, 'notebook.manage', deps);
	await assertProjectRole(deps.services.projects, destination, user, 'notebook.manage', deps);
	const snapshotCompute = asFilesystemSnapshots(deps.compute);
	const meta = await deps.services.moves.move({
		source: pid,
		destination,
		notebookId: nid,
		actor: user.id,
		idempotencyKey: c.req.valid('header')['idempotency-key'],
		expectedVersion: ifMatchToken(c),
		reclaimSnapshot: snapshotCompute
			? async (snapshot) => {
					await snapshotCompute.deleteSnapshot(snapshot.snapshot_id);
				}
			: undefined,
		authorize: async ({ sourceProject, destinationProject, notebook, source, repositories }) => {
			for (const project of [sourceProject, destinationProject]) {
				for (const action of ['project.read', 'notebook.manage'] as const) {
					await assertProjectActionOn(project, user, action, deps, notebook.security_labels);
				}
			}
			const previous = sourceProject.security_labels;
			if (
				previous &&
				![destinationProject.security_labels, notebook.security_labels].some(
					(labels) => labels && isMonotonicRestrictionIncrease(previous, labels),
				)
			)
				throw new ValidationError(
					'The destination must preserve the source project security labels',
				);
			if (source.type !== 'git') return;
			for (const revision of repositories) {
				const provider = providerForRepo(
					{ ...source, provider: revision.provider ?? source.provider },
					revision.repo,
					deps.sourceControl?.repositoryHosts,
				);
				if (provider) {
					if (!deps.sourceControl?.assertRepositoryAllowed)
						throw new ValidationError('Destination repository authorization is unavailable');
					deps.sourceControl.assertRepositoryAllowed(provider, revision.repo, destination);
				}
			}
			if (source.sync_mode === 'pull') {
				assertPullSourceSupported(deps, source, destination);
				const configs = [source, ...(source.pending_config ? [source.pending_config] : [])];
				for (const config of configs) {
					const provider = providerForRepo(
						source,
						config.repo,
						deps.sourceControl?.repositoryHosts,
					);
					const reader = provider
						? deps.sourceControl?.getReader(provider, destination)
						: undefined;
					if (!reader?.supportsRepository(config.repo))
						throw new ValidationError('Destination cannot read the Git repository');
					await reader.getBranchHead(config.repo, config.branch, { signal: c.req.raw.signal });
				}
			}
		},
	});
	c.header('ETag', etagFor(meta.updated_at));
	return c.json({ success: true, data: toPublicNotebookMeta(meta) }, 200);
});

export default app;
