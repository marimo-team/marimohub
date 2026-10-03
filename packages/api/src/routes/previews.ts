import { createRoute, z } from '@hono/zod-openapi';
import {
	PreviewNotReadyError,
	ValidationError,
	NotFoundError,
	PreviewCreateSchema,
	PreviewIdSchema,
	PreviewSourceSchema,
} from '@marimo-hub/core';
import type { NotebookPreview, NotebookId, ProjectId } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { checkComputeProfile } from '../computeProfile';
import { PaginationQuery, pageSchema, paginate } from '../pagination';
import {
	assertProjectRole,
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	IdempotencyKeyHeader,
	jsonBody,
	jsonContent,
	loadAuthorizedNotebook,
	loadSessionProject,
	NotebookIdParam,
	resolvePublicBaseUrl,
} from '../shared';
import {
	authorizeSessionStart,
	SessionCreateResponseSchema,
	startNotebookSession,
} from './sessions';

const base = '/projects/{pid}/notebooks/{nid}/previews';
const Params = NotebookIdParam.extend({ preview_id: PreviewIdSchema });
const PublicPreview = z
	.object({
		id: PreviewIdSchema,
		name: z.string(),
		state: z.enum(['active', 'deleting', 'deleted']),
		preparation: z.enum(['pending', 'preparing', 'ready', 'failed']),
		source_type: z.enum(['branch', 'commit']),
		source: PreviewSourceSchema.optional(),
		repository: z.string().optional(),
		commit: z.string().optional(),
		version_id: z.string().optional(),
		error: z.string().optional(),
		expires_at: z.string(),
		created_at: z.string(),
		compute_profile: z.string().optional(),
		url: z.string(),
		can: z.object({ manage: z.boolean(), app: z.boolean(), edit: z.boolean() }),
	})
	.openapi('NotebookPreview');
const Response = z.object({ success: z.literal(true), data: PublicPreview });
const errors = { ...commonErrors(), ...errorResponses(400, 403, 404, 409, 422, 429) };
const create = createRoute({
	method: 'post',
	path: base,
	operationId: 'notebooks.previews.create',
	tags: ['Previews'],
	summary: 'Create a notebook preview',
	description:
		'Creation persists intent and returns immediately; preparation runs asynchronously. Idempotency keys are retained for seven days from creation. Branch previews automatically publish future branch commits. Commit previews remain pinned. Previews inherit notebook access, integrations, and secrets. Editors are temporary and never write back.',
	request: {
		params: NotebookIdParam,
		headers: IdempotencyKeyHeader,
		body: jsonBody(PreviewCreateSchema),
	},
	responses: { 202: jsonContent(Response, 'Preview accepted for preparation'), ...errors },
});
const list = createRoute({
	method: 'get',
	path: base,
	operationId: 'notebooks.previews.list',
	tags: ['Previews'],
	summary: 'List notebook previews',
	request: { params: NotebookIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(PublicPreview, 'NotebookPreviewPage'),
			}),
			'Previews',
		),
		...errors,
	},
});
const get = createRoute({
	method: 'get',
	path: `${base}/{preview_id}`,
	operationId: 'notebooks.previews.get',
	tags: ['Previews'],
	summary: 'Get a notebook preview',
	request: { params: Params },
	responses: { 200: jsonContent(Response, 'Preview'), ...errors },
});
const remove = createRoute({
	method: 'delete',
	path: `${base}/{preview_id}`,
	operationId: 'notebooks.previews.delete',
	tags: ['Previews'],
	summary: 'Delete a preview and retire its compute',
	request: { params: Params },
	responses: {
		202: jsonContent(
			z.object({ success: z.literal(true), data: z.null() }),
			'Preview revoked; cleanup pending',
		),
		...errors,
	},
});
const launch = createRoute({
	method: 'post',
	path: `${base}/{preview_id}/sessions`,
	operationId: 'notebooks.previews.sessions.create',
	tags: ['Previews'],
	summary: 'Run a preview app or temporary editor',
	request: {
		params: Params,
		body: jsonBody(
			z.strictObject({
				mode: z.enum(['app', 'edit']),
				app_visit_id: z.string().min(1).max(128).optional(),
			}),
		),
	},
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: SessionCreateResponseSchema.openapi('PreviewSessionCreateResult'),
			}),
			'Preview session',
		),
		...errors,
	},
});
const discover = createRoute({
	method: 'get',
	path: '/projects/{pid}/notebooks/{nid}/source/refs',
	operationId: 'notebooks.source.refs',
	tags: ['Previews'],
	summary: 'Suggest GitHub branches or recent commits',
	description:
		'Returns at most 30 matches from the first 100 branches or recent commits. Manual values remain supported. Providers without suggestion support return 422; explicit resolution remains available.',
	request: {
		params: NotebookIdParam,
		query: z.object({
			type: z.enum(['branch', 'commit']),
			query: z.string().max(250).default(''),
			resolve: z.enum(['true', 'false']).optional(),
		}),
	},
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z
					.array(z.object({ value: z.string(), commit: z.string(), label: z.string() }))
					.max(30),
			}),
			'Source suggestions',
		),
		...errors,
	},
});
const app = createApp();

async function visible(
	deps: ApiDeps,
	pid: ProjectId,
	nid: NotebookId,
	user: Parameters<typeof loadSessionProject>[2],
) {
	const project = await loadSessionProject(deps.services.projects, pid, user, deps);
	const notebook = await loadAuthorizedNotebook(
		deps,
		project,
		nid,
		user,
		authorizationService(deps).appReadAction(user, project),
	);
	return { project, notebook };
}
async function manageable(
	deps: ApiDeps,
	pid: ProjectId,
	nid: NotebookId,
	user: Parameters<typeof loadSessionProject>[2],
) {
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'preview.manage',
		deps,
	);
	const notebook = await loadAuthorizedNotebook(deps, project, nid, user, 'preview.manage');
	return { project, notebook };
}
function present(
	record: NotebookPreview,
	can: z.infer<typeof PublicPreview>['can'],
	baseUrl: string,
) {
	return {
		id: record.id,
		name: record.name,
		state: record.state,
		preparation: record.preparation,
		source_type: record.source.type,
		...(can.manage
			? {
					source: record.source,
					repository: record.repository,
					compute_profile: record.compute_profile,
				}
			: {}),
		commit: record.current?.commit,
		version_id: record.current?.version_id,
		error: record.error,
		expires_at: record.expires_at,
		created_at: record.created_at,
		url: `${baseUrl}/projects/${record.project_id}/notebooks/${record.notebook_id}/previews/${record.id}`,
		can,
	};
}
async function grants(
	deps: ApiDeps,
	user: Parameters<typeof loadSessionProject>[2],
	{ project, notebook }: Awaited<ReturnType<typeof visible>>,
) {
	const manage = await authorizationService(deps).authorize(user, 'preview.manage', {
		kind: 'project',
		project,
		notebookLabels: notebook.meta.security_labels,
	});
	const [app, edit] = await Promise.all(
		['app', 'edit'].map((mode) =>
			authorizationService(deps).authorize(user, 'session.start', {
				kind: 'session-start',
				project,
				mode: mode as 'app' | 'edit',
				notebookLabels: notebook.meta.security_labels,
			}),
		),
	);
	return { manage: manage.allowed, app: app.allowed, edit: edit.allowed };
}
app.openapi(create, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const access = await manageable(deps, pid, nid, user);
	const input = c.req.valid('json');
	if (input.compute_profile) {
		checkComputeProfile(deps.sandbox, input.compute_profile);
		if (
			input.compute_profile === 'default' &&
			!deps.sandbox.computeProfiles?.some((profile) => profile.name === 'default')
		)
			input.compute_profile = undefined;
	}
	const record = await deps.services.previews.create(
		pid,
		nid,
		input,
		user.id,
		deps.sourceControl,
		c.req.header('Idempotency-Key'),
	);
	return c.json(
		{
			success: true as const,
			data: present(
				record,
				await grants(deps, user, access),
				resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
			),
		},
		202,
	);
});
app.openapi(list, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	const user = c.get('user');
	const can = await grants(deps, user, await visible(deps, pid, nid, user));
	return c.json(
		{
			success: true as const,
			data: paginate(
				(await deps.services.previews.list(pid, nid)).map((record) =>
					present(record, can, resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl)),
				),
				c.req.valid('query'),
				{ key: (record) => record.created_at, tiebreak: (record) => record.id },
			),
		},
		200,
	);
});
app.openapi(get, async (c) => {
	const deps = c.get('deps');
	const { pid, nid, preview_id } = c.req.valid('param');
	const user = c.get('user');
	const can = await grants(deps, user, await visible(deps, pid, nid, user));
	const record = await deps.services.previews.get(pid, nid, preview_id);
	if (record.state !== 'active' || Date.parse(record.expires_at) <= Date.now())
		throw new NotFoundError('Preview not found');
	return c.json(
		{
			success: true as const,
			data: present(record, can, resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl)),
		},
		200,
	);
});
app.openapi(remove, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, preview_id } = c.req.valid('param');
	await manageable(deps, pid, nid, user);
	await deps.services.previews.retire(await deps.services.previews.get(pid, nid, preview_id));
	return c.json({ success: true as const, data: null }, 202);
});
app.openapi(launch, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, preview_id } = c.req.valid('param');
	const { project, notebook } = await visible(deps, pid, nid, user);
	await authorizeSessionStart(
		project,
		user,
		c.req.valid('json').mode,
		deps,
		notebook.meta.security_labels ?? null,
	);
	const record = await deps.services.previews.get(pid, nid, preview_id);
	if (record.state !== 'active' || Date.parse(record.expires_at) <= Date.now())
		throw new NotFoundError('Preview not found');
	if (!record.current) throw new PreviewNotReadyError();
	const data = await startNotebookSession({
		deps,
		user,
		pid,
		nid: record.current.notebook_id,
		preview: { id: preview_id, notebook_id: nid },
		body: c.req.valid('json'),
		request: {
			method: c.req.method,
			path: c.req.path,
			hostname: new URL(c.req.url).hostname,
			appBaseUrl: resolvePublicBaseUrl(c, deps.sandbox.appBaseUrl),
		},
	});
	return c.json({ success: true as const, data }, 200);
});
app.openapi(discover, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	await manageable(deps, pid, nid, user);
	const query = c.req.valid('query');
	if (query.resolve === 'true' && !query.query.trim()) {
		throw new ValidationError('A nonblank query is required to resolve a source reference');
	}
	const { source, reader } = await deps.services.previews.source(pid, nid, deps.sourceControl);
	const options = { signal: c.req.raw.signal };
	if (
		query.resolve !== 'true' &&
		!(query.type === 'branch' ? reader.listBranches : reader.listCommits)
	) {
		throw new ValidationError(`Source provider does not support ${query.type} suggestions`);
	}
	const data =
		query.resolve === 'true'
			? [
					{
						value: query.query,
						label: query.query,
						...(query.type === 'branch'
							? await reader.getBranchHead(source.repo, query.query, options)
							: await reader.resolveCommit!(source.repo, query.query, options)),
					},
				]
			: query.type === 'branch'
				? await reader.listBranches!(source.repo, query.query, options)
				: await reader.listCommits!(source.repo, query.query, options);
	return c.json({ success: true as const, data: data.slice(0, 30) }, 200);
});
export default app;
