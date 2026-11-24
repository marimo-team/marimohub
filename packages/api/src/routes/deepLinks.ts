import { ulidString } from '@marimo-hub/core/string-formats';
import { createRoute, z } from '@hono/zod-openapi';
import {
	ConflictError,
	DeepLinkSchema,
	DeepLinkSlugSchema,
	NotFoundError,
	ValidationError,
} from '@marimo-hub/core';
import {
	assertProjectRole,
	assertSessionAuthenticated,
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	loadAuthorizedNotebookMeta,
	loadVisibleProject,
	loadSessionProject,
	NotebookIdParam,
	retirePublicApps,
	SESSION_ONLY_SECURITY,
} from '../shared';
import { AppSummarySchema, appSummary } from './apps';

const SlugParam = z.object({ slug: DeepLinkSlugSchema });
const LinkSchema = z.strictObject(DeepLinkSchema.shape).openapi('DeepLink');
const LinkResponse = z.object({ success: z.literal(true), data: LinkSchema });
const errors = { ...commonErrors(), ...errorResponses(403, 404, 409, 422) };
const notebookPath = '/projects/{pid}/notebooks/{nid}/deep-links';
const RegisterAccessSchema = z.strictObject({ mode: z.literal('inherit') });
const UpdateAccessBodySchema = z.strictObject({
	registration_id: ulidString(),
	access: z
		.strictObject({
			mode: z.enum(['inherit', 'public']),
			allow_project_integrations: z.boolean().optional(),
		})
		.superRefine((access, ctx) => {
			if (access.mode === 'inherit' && access.allow_project_integrations !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['allow_project_integrations'],
					message: 'allow_project_integrations is only allowed when mode is "public"',
				});
			}
		}),
});

const resolve = createRoute({
	method: 'get',
	path: '/deep-links/{slug}',
	operationId: 'deep-links.resolve',
	tags: ['App links'],
	summary: 'Resolve an app link using notebook permissions',
	request: { params: SlugParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				// NotebookApp is a shared component, so the `app` note lives on this inline object.
				data: z
					.strictObject({ ...LinkSchema.shape, app: AppSummarySchema })
					.describe(
						'The app link. `app` is the app summary for the link target. App users and callers whose token grants `app.read` need `app.read` on the project and notebook; other callers need `project.read`.',
					),
			}),
			'Authorized app link',
		),
		...errors,
	},
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
				access: RegisterAccessSchema.default({ mode: 'inherit' }),
			}),
		),
	},
	responses: {
		200: jsonContent(LinkResponse, 'New or existing app link for this notebook'),
		...errors,
	},
});
const updateAccess = createRoute({
	method: 'patch',
	path: `${notebookPath}/{slug}`,
	operationId: 'deep-links.updateAccess',
	tags: ['App links'],
	summary: 'Enable or disable public access for an app link',
	description:
		'Enabling public access requires a browser session, the `deep-link.publish` permission, and a committed notebook without security labels. Disabling immediately invalidates the public pool and stops live public sandboxes.',
	security: SESSION_ONLY_SECURITY,
	request: {
		params: NotebookIdParam.extend(SlugParam.shape),
		body: jsonBody(UpdateAccessBodySchema),
	},
	responses: {
		200: jsonContent(LinkResponse, 'Updated app link'),
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
		'Releases the slug only when the notebook and registration ID match. The slug is immediately available for reuse. Old shared URLs can then open another notebook. Authenticated app sessions and notebook permissions stay unchanged; public app sessions are retired when no public link remains.',
	request: {
		params: NotebookIdParam.extend(SlugParam.shape),
		query: z.object({ registration_id: ulidString() }),
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
// Proxies can decode %2F before routing; OpenAPI still describes one slug parameter.
app.openAPIRegistry.registerPath(resolve);
app.openAPIRegistry.registerPath(updateAccess);
app.openAPIRegistry.registerPath(release);
app.openapi({ ...resolve, path: '/deep-links/:slug{[\\s\\S]+}', hide: true }, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const link = await deps.services.deepLinks.resolve(c.req.valid('param').slug);
	const project = await loadSessionProject(
		deps.services.projects,
		link.target.project_id,
		user,
		deps,
	);
	const meta = await loadAuthorizedNotebookMeta(
		deps,
		project,
		link.target.notebook_id,
		user,
		authorizationService(deps).appReadAction(user, project),
	);
	return c.json(
		{
			success: true as const,
			data: {
				...link,
				app: await appSummary(deps, user, project, meta, meta.security_labels ?? null),
			},
		},
		200,
	);
});
app.openapi(list, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'project.read');
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
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.manage');
	const link = await deps.services.deepLinks.register(
		c.req.valid('json').slug,
		{ kind: 'app', project_id: pid, notebook_id: nid },
		user.id,
	);
	return c.json({ success: true as const, data: link }, 200);
});
app.openapi(
	{ ...updateAccess, path: `${notebookPath}/:slug{[\\s\\S]+}`, hide: true },
	async (c) => {
		const deps = c.get('deps');
		const user = c.get('user');
		const { pid, nid, slug } = c.req.valid('param');
		const body = c.req.valid('json');
		const target = { kind: 'app' as const, project_id: pid, notebook_id: nid };

		if (body.access.mode === 'public') {
			assertSessionAuthenticated(c, 'enable public access for an app link');
			if (!deps.publicApps) {
				throw new ValidationError('Public app links are disabled on this deployment');
			}
			if (body.access.allow_project_integrations && !deps.publicApps.allowProjectIntegrations) {
				throw new ValidationError(
					'Project integrations for public app links are disabled on this deployment',
				);
			}
			const project = await assertProjectRole(
				deps.services.projects,
				pid,
				user,
				'deep-link.publish',
				deps,
			);
			const meta = await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.publish');
			if (meta.preview) throw new NotFoundError('Notebook not found');
			if (project.security_labels !== undefined || meta.security_labels !== undefined) {
				throw new ConflictError('Notebooks or projects with security labels cannot be made public');
			}
			const notebook = await deps.services.notebooks.getNotebook(pid, nid);
			if (!notebook.source.current_version_id) {
				throw new ConflictError('Save or commit a notebook version before making this link public');
			}
			const { link, changed, wasPublic } = await deps.services.deepLinks.setAccess(
				slug,
				target,
				body.registration_id,
				{
					mode: 'public',
					allow_project_integrations: body.access.allow_project_integrations,
				},
				user.id,
			);
			if (changed && wasPublic) {
				const variant = body.access.allow_project_integrations ? 'default' : 'integrations';
				if (!(await deps.services.deepLinks.hasPublicLinks(pid, nid, variant))) {
					await retirePublicApps(deps, pid, nid, [
						variant === 'integrations' ? 'public-integrations' : 'public',
					]);
				}
			}
			if (changed) {
				await deps.services.events
					.append({
						event: 'deep_link.public.enabled',
						actor: user.id,
						project_id: pid,
						notebook_id: nid,
						slug: link.slug,
						allow_project_integrations: Boolean(link.access.allow_project_integrations),
					})
					.catch(() => {});
			}
			return c.json({ success: true as const, data: link }, 200);
		}

		// Disabling public access works even if the deployment gate was later turned off.
		const project = await assertProjectRole(
			deps.services.projects,
			pid,
			user,
			'deep-link.manage',
			deps,
		);
		await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.manage');
		const { link, changed, wasPublic } = await deps.services.deepLinks.setAccess(
			slug,
			target,
			body.registration_id,
			{ mode: 'inherit' },
			user.id,
		);
		if (wasPublic) {
			const [hasDefault, hasIntegrations] = await Promise.all([
				deps.services.deepLinks.hasPublicLinks(pid, nid, 'default'),
				deps.services.deepLinks.hasPublicLinks(pid, nid, 'integrations'),
			]);
			const toRetire = [
				...(!hasDefault ? (['public'] as const) : []),
				...(!hasIntegrations ? (['public-integrations'] as const) : []),
			];
			if (toRetire.length > 0) await retirePublicApps(deps, pid, nid, toRetire);
			if (changed) {
				await deps.services.events
					.append({
						event: 'deep_link.public.disabled',
						actor: user.id,
						project_id: pid,
						notebook_id: nid,
						slug: link.slug,
					})
					.catch(() => {});
			}
		}
		return c.json({ success: true as const, data: link }, 200);
	},
);
app.openapi({ ...release, path: `${notebookPath}/:slug{[\\s\\S]+}`, hide: true }, async (c) => {
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
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.manage');
	const existing = await deps.services.deepLinks.resolve(slug).catch(() => null);
	await deps.services.deepLinks.release(
		slug,
		{ kind: 'app', project_id: pid, notebook_id: nid },
		c.req.valid('query').registration_id,
	);
	if (
		existing &&
		existing.registration_id === c.req.valid('query').registration_id &&
		existing.access.mode === 'public'
	) {
		const variant = existing.access.allow_project_integrations ? 'integrations' : 'default';
		if (!(await deps.services.deepLinks.hasPublicLinks(pid, nid, variant))) {
			await retirePublicApps(deps, pid, nid, [
				variant === 'integrations' ? 'public-integrations' : 'public',
			]);
		}
	}
	return c.json({ success: true as const, data: null }, 200);
});
export default app;
