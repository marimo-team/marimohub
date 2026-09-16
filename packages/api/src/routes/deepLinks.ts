import { createRoute, z } from '@hono/zod-openapi';
import { DeepLinkAccessSchema, DeepLinkSchema, DeepLinkSlugSchema } from '@marimo-hub/core';
import {
	assertProjectRole,
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	loadAuthorizedNotebook,
	loadVisibleProject,
	loadSessionProject,
	NotebookIdParam,
} from '../shared';

const SlugParam = z.object({ slug: DeepLinkSlugSchema });
const LinkSchema = z.strictObject(DeepLinkSchema.shape).openapi('DeepLink');
const LinkResponse = z.object({ success: z.literal(true), data: LinkSchema });
const errors = { ...commonErrors(), ...errorResponses(403, 404, 409, 422) };
const notebookPath = '/projects/{pid}/notebooks/{nid}/deep-links';
const resolve = createRoute({
	method: 'get',
	path: '/deep-links/{slug}',
	operationId: 'deep-links.resolve',
	tags: ['App links'],
	summary: 'Resolve an app link using notebook permissions',
	request: { params: SlugParam },
	responses: { 200: jsonContent(LinkResponse, 'Authorized app link'), ...errors },
});
const list = createRoute({
	method: 'get',
	path: notebookPath,
	operationId: 'deep-links.list',
	tags: ['App links'],
	summary: 'List notebook app links',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(LinkSchema) }),
			'App links',
		),
		...errors,
	},
});
const register = createRoute({
	method: 'post',
	path: notebookPath,
	operationId: 'deep-links.register',
	tags: ['App links'],
	summary: 'Register a globally unique app slug',
	request: {
		params: NotebookIdParam,
		body: jsonBody(
			z.strictObject({
				slug: DeepLinkSlugSchema,
				kind: z.literal('app').default('app'),
				access: DeepLinkAccessSchema.default({ mode: 'inherit' }),
			}),
		),
	},
	responses: {
		200: jsonContent(LinkResponse, 'New or existing app link for this notebook'),
		...errors,
	},
});
const release = createRoute({
	method: 'delete',
	path: `${notebookPath}/{slug}`,
	operationId: 'deep-links.release',
	tags: ['App links'],
	summary: 'Release an app slug for immediate reuse',
	description:
		'Releases the slug only when the notebook and registration ID match. The slug is immediately available for reuse. Old shared URLs can then open another notebook. App sessions and notebook permissions stay unchanged.',
	request: {
		params: NotebookIdParam.extend(SlugParam.shape),
		query: z.object({ registration_id: z.ulid() }),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.null() }),
			'Registration released, absent, or replaced',
		),
		...errors,
	},
});

const app = createApp();
app.openapi(resolve, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const link = await deps.services.deepLinks.resolve(c.req.valid('param').slug);
	const project = await loadSessionProject(
		deps.services.projects,
		link.target.project_id,
		user,
		deps,
	);
	await loadAuthorizedNotebook(
		deps,
		project,
		link.target.notebook_id,
		user,
		authorizationService(deps).appReadAction(user, project),
	);
	return c.json({ success: true as const, data: link }, 200);
});
app.openapi(list, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	await loadAuthorizedNotebook(deps, project, nid, user, 'project.read');
	return c.json(
		{
			success: true as const,
			data: await deps.services.deepLinks.list({ kind: 'app', project_id: pid, notebook_id: nid }),
		},
		200,
	);
});
app.openapi(register, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'deep-link.manage',
		deps,
	);
	await loadAuthorizedNotebook(deps, project, nid, user, 'deep-link.manage');
	const link = await deps.services.deepLinks.register(
		c.req.valid('json').slug,
		{ kind: 'app', project_id: pid, notebook_id: nid },
		user.id,
	);
	return c.json({ success: true as const, data: link }, 200);
});
app.openapi(release, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, slug } = c.req.valid('param');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'deep-link.manage',
		deps,
	);
	await loadAuthorizedNotebook(deps, project, nid, user, 'deep-link.manage');
	await deps.services.deepLinks.release(
		slug,
		{ kind: 'app', project_id: pid, notebook_id: nid },
		c.req.valid('query').registration_id,
	);
	return c.json({ success: true as const, data: null }, 200);
});
export default app;
