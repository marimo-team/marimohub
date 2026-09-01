import { createRoute, z } from '@hono/zod-openapi';
import {
	INTEGRATION_CATEGORIES,
	IntegrationId,
	NotFoundError,
	ProjectId,
	ResourceExhaustedError,
	createSlidingWindowBudget,
} from '@marimo-hub/core';
import type {
	IntegrationDetail,
	IntegrationEntry,
	ObjectBrowseContext,
	ProjectIntegrationsService,
	OrgIntegrationsService,
	QueryReadinessRequest,
	SlidingWindowBudget,
	TestIntegrationRequest,
} from '@marimo-hub/core';
import {
	assertProjectActionOn,
	assertProjectRole,
	assertSuperAdmin,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	extensibleResponseEnum,
	IfMatchHeader,
	ifMatchToken,
	jsonBody,
	jsonContent,
	loadVisibleProject,
	ProjectIdParam,
	SuccessResponseSchema,
} from '../shared';
import type { ApiDeps } from '../shared';
import {
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	pageSchema,
	paginate,
	PaginationQuery,
} from '../pagination';
import { appendAudit } from '../log';
import integrationBrowseApp from './integrationBrowse';
import { makeObjectBrowseContext } from './objectBrowse';

export { clearIntegrationBrowseStateForTests } from './integrationBrowse';

const IntegrationIdSchema = z.string().regex(IntegrationId.regex).refine(IntegrationId.is);
const IntegrationNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const IidParam = z
	.string()
	.regex(IntegrationId.regex)
	.refine(IntegrationId.is)
	.openapi({ param: { name: 'iid', in: 'path' }, example: 'intg-7h2k9qm4xz7rp3w8' });

const IntegrationIdParam = ProjectIdParam.extend({ iid: IidParam });

const OrgIntegrationIdParam = z.object({ iid: IidParam });

// Per-kind config shapes are dynamic (each kind owns a Zod schema, serialized to
// clients as `KindDescriptor.json_schema`), so the route layer types config as an
// open object and the store validates it against the kind's schema (→ 422).
const ConfigSchema = z.record(z.string(), z.unknown());

const KindDescriptorSchema = z
	.object({
		kind: z.string().min(1).openapi({ example: 'postgres' }),
		title: z.string(),
		description: z.string(),
		category: z.enum(INTEGRATION_CATEGORIES),
		brand: z.object({
			icon: z.string().min(1).optional().openapi({ example: 'postgresql' }),
			color: z
				.string()
				.regex(/^#[0-9A-Fa-f]{6}$/)
				.openapi({ example: '#4169E1' }),
		}),
		schema_version: z.number().int().positive(),
		json_schema: z.record(z.string(), z.unknown()),
		ui_hints: z.record(
			z.string(),
			z.object({
				widget: z
					.enum(['text', 'password', 'textarea', 'select', 'toggle', 'number', 'kv-pairs'])
					.optional(),
				placeholder: z.string().optional(),
				group: z.string().optional(),
				order: z.number().optional(),
				advanced: z.boolean().optional(),
				docs_url: z.string().optional(),
			}),
		),
		supports_test: z.boolean(),
		supports_browse: z.boolean(),
		browse_surfaces: z.array(extensibleResponseEnum(['tables', 'objects'], 'tables')),
		secret_sources: z.object({
			inline: z.boolean(),
			references: z.array(
				z.object({
					backend: z.string().min(1).openapi({ example: 'aws-sm' }),
					title: z.string().min(1).openapi({ example: 'AWS Secrets Manager' }),
					locator_placeholder: z.string().min(1),
					locator_help: z.string().min(1),
					docs_url: z.url().optional(),
				}),
			),
		}),
		/** Informational package requirements for the rendered sandbox contract. */
		requirements: z.array(z.string()),
	})
	.openapi('IntegrationKind');

const IntegrationEntrySchema = z
	.object({
		id: IntegrationIdSchema,
		kind: z.string().min(1),
		name: IntegrationNameSchema,
		enabled: z.boolean(),
		current_version: z.number().int().positive(),
		created_by: z.string().min(1),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		scope: z.enum(['project', 'org']),
		/** Org entries in a project listing: a same-name project integration overrides this one. */
		shadowed: z.boolean().optional(),
	})
	.openapi('IntegrationEntry');

// `config` never contains plaintext or ciphertext. Inline values are redacted;
// external references retain their backend and locator metadata.
const IntegrationDetailSchema = IntegrationEntrySchema.extend({
	config: ConfigSchema,
	change_note: z.string().optional(),
}).openapi('IntegrationDetail');

const IntegrationVersionSchema = z
	.object({
		version: z.number().int().positive(),
		kind_schema_version: z.number().int().positive(),
		created_by: z.string().min(1),
		created_at: z.iso.datetime(),
		change_note: z.string().optional(),
	})
	.openapi('IntegrationVersion');

const TestResultSchema = z
	.object({
		ok: z.boolean(),
		latency_ms: z.number().nonnegative().optional(),
		/** User-safe probe details; never secret material. */
		details: z.string().optional(),
	})
	.openapi('IntegrationTestResult');

const CreateIntegrationBody = z
	.object({
		kind: z.string().min(1),
		name: IntegrationNameSchema.openapi({ example: 'prod' }),
		config: ConfigSchema,
		change_note: z.string().max(500).optional(),
	})
	.strict();

const UpdateIntegrationBody = z
	.object({
		name: IntegrationNameSchema.optional(),
		enabled: z.boolean().optional(),
		/** When present, appends a config version and preserves untouched secrets. */
		config: ConfigSchema.optional(),
		change_note: z.string().max(500).optional(),
	})
	.refine(
		(body) => body.name !== undefined || body.enabled !== undefined || body.config !== undefined,
		'At least one of name, enabled, or config is required.',
	)
	// A note without a config would be silently dropped (notes ride version records).
	.refine(
		(body) => body.change_note === undefined || body.config !== undefined,
		'change_note requires config.',
	)
	.strict();

const TestIntegrationBody = z
	.discriminatedUnion('source', [
		z
			.object({
				source: z.literal('draft'),
				kind: z.string().min(1),
				config: ConfigSchema,
				id: IntegrationIdSchema.optional(),
			})
			.strict(),
		z.object({ source: z.literal('stored'), id: IntegrationIdSchema }).strict(),
	])
	.openapi('IntegrationTestRequest');

const QueryReadinessBody = z
	.object({ kind: z.string().min(1), config: ConfigSchema })
	.strict()
	.openapi('IntegrationQueryReadinessRequest');

const QueryReadinessCheckSchema = z
	.object({
		id: z.string().min(1),
		label: z.string().min(1),
		ready: z.boolean(),
		field: z.string(),
		reason: z.string().min(1),
	})
	.openapi('IntegrationQueryReadinessCheck');

const CopyIntegrationBody = z
	.object({
		source_project_id: z
			.string()
			.regex(ProjectId.regex)
			.refine(ProjectId.is)
			.openapi({ example: 'proj-7h2k9qm4xz7rp3w8' }),
		source_integration_id: z
			.string()
			.regex(IntegrationId.regex)
			.refine(IntegrationId.is)
			.openapi({ example: 'intg-7h2k9qm4xz7rp3w8' }),
		/** Name for the copy; defaults to the source instance's name. */
		name: IntegrationNameSchema.optional(),
	})
	.strict()
	.openapi('IntegrationCopyRequest');

const listKinds = createRoute({
	method: 'get',
	path: '/integrations/kinds',
	operationId: 'integrations.kinds.list',
	tags: ['Integrations'],
	summary: 'List available integration kinds (schemas drive the config forms)',
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(KindDescriptorSchema) }),
			'Registered integration kinds',
		),
		...commonErrors(),
	},
});

const listIntegrations = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations',
	operationId: 'integrations.project.list',
	tags: ['Integrations'],
	summary: "List a project's integrations",
	request: { params: ProjectIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationEntrySchema, 'IntegrationPage'),
			}),
			'Integration instances (no config)',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const createIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations',
	operationId: 'integrations.project.create',
	tags: ['Integrations'],
	summary: 'Create an integration (manager only)',
	request: { params: ProjectIdParam, body: jsonBody(CreateIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration created (config redacted)',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const getIntegration = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}',
	operationId: 'integrations.project.get',
	tags: ['Integrations'],
	summary: 'Get an integration with its redacted config',
	request: { params: IntegrationIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration detail (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const updateIntegration = createRoute({
	method: 'patch',
	path: '/projects/{pid}/integrations/{iid}',
	operationId: 'integrations.project.update',
	tags: ['Integrations'],
	summary: 'Update an integration (manager only); a config change appends a version',
	request: {
		params: IntegrationIdParam,
		headers: IfMatchHeader,
		body: jsonBody(UpdateIntegrationBody),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration updated (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const deleteIntegration = createRoute({
	method: 'delete',
	path: '/projects/{pid}/integrations/{iid}',
	operationId: 'integrations.project.delete',
	tags: ['Integrations'],
	summary: 'Delete an integration and its version history (manager only)',
	request: { params: IntegrationIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Integration deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listIntegrationVersions = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}/versions',
	operationId: 'integrations.project.versions',
	tags: ['Integrations'],
	summary: "List an integration's config versions (metadata only)",
	request: { params: IntegrationIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationVersionSchema, 'IntegrationVersionPage'),
			}),
			'Version history, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const copyIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/copy',
	operationId: 'integrations.project.copy',
	tags: ['Integrations'],
	summary: 'Copy an integration from another project (manager of both projects)',
	request: { params: ProjectIdParam, body: jsonBody(CopyIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration copied (inline secrets re-encrypted; external references preserved)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const testIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/test',
	operationId: 'integrations.project.test',
	tags: ['Integrations'],
	summary: 'Probe connectivity for an unsaved config or a stored instance (manager only)',
	request: { params: ProjectIdParam, body: jsonBody(TestIntegrationBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: TestResultSchema }),
			'Probe outcome (never secret material)',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const queryReadiness = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/query-readiness',
	operationId: 'integrations.project.query-readiness',
	tags: ['Integrations'],
	summary: 'Evaluate SQL readiness for an unsaved integration config (manager only)',
	request: { params: ProjectIdParam, body: jsonBody(QueryReadinessBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(QueryReadinessCheckSchema) }),
			'All SQL readiness checks',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

// Org-scoped (deployment-wide) instances, inherited by every project. All
// management is super-admin only — org integrations render into every
// project's sessions, so no project role can be sufficient.
const listOrgIntegrations = createRoute({
	method: 'get',
	path: '/org/integrations',
	operationId: 'integrations.org.list',
	tags: ['Integrations'],
	summary: 'List org-wide integrations (super admin only)',
	request: { query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationEntrySchema, 'IntegrationPage'),
			}),
			'Org integration instances (no config)',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const createOrgIntegration = createRoute({
	method: 'post',
	path: '/org/integrations',
	operationId: 'integrations.org.create',
	tags: ['Integrations'],
	summary: 'Create an org-wide integration (super admin only)',
	request: { body: jsonBody(CreateIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration created (config redacted)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const getOrgIntegration = createRoute({
	method: 'get',
	path: '/org/integrations/{iid}',
	operationId: 'integrations.org.get',
	tags: ['Integrations'],
	summary: 'Get an org-wide integration with its redacted config (super admin only)',
	request: { params: OrgIntegrationIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration detail (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const updateOrgIntegration = createRoute({
	method: 'patch',
	path: '/org/integrations/{iid}',
	operationId: 'integrations.org.update',
	tags: ['Integrations'],
	summary: 'Update an org-wide integration (super admin only)',
	request: {
		params: OrgIntegrationIdParam,
		headers: IfMatchHeader,
		body: jsonBody(UpdateIntegrationBody),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration updated (config redacted)',
			EtagResponseHeader,
		),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const deleteOrgIntegration = createRoute({
	method: 'delete',
	path: '/org/integrations/{iid}',
	operationId: 'integrations.org.delete',
	tags: ['Integrations'],
	summary: 'Delete an org-wide integration and its version history (super admin only)',
	request: { params: OrgIntegrationIdParam, headers: IfMatchHeader },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Integration deleted'),
		...commonErrors(),
		...errorResponses(403, 404, 412),
	},
});

const listOrgIntegrationVersions = createRoute({
	method: 'get',
	path: '/org/integrations/{iid}/versions',
	operationId: 'integrations.org.versions',
	tags: ['Integrations'],
	summary: "List an org-wide integration's config versions (super admin only)",
	request: { params: OrgIntegrationIdParam, query: PaginationQuery },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(IntegrationVersionSchema, 'IntegrationVersionPage'),
			}),
			'Version history, newest first',
		),
		...commonErrors(),
		...errorResponses(400, 403, 404),
	},
});

const testOrgIntegration = createRoute({
	method: 'post',
	path: '/org/integrations/test',
	operationId: 'integrations.org.test',
	tags: ['Integrations'],
	summary: 'Probe connectivity for an unsaved or stored org config (super admin only)',
	request: { body: jsonBody(TestIntegrationBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: TestResultSchema }),
			'Probe outcome (never secret material)',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const queryOrgReadiness = createRoute({
	method: 'post',
	path: '/org/integrations/query-readiness',
	operationId: 'integrations.org.query-readiness',
	tags: ['Integrations'],
	summary: 'Evaluate SQL readiness for an unsaved org config (super admin only)',
	request: { body: jsonBody(QueryReadinessBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(QueryReadinessCheckSchema) }),
			'All SQL readiness checks',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

function requireIntegrations(deps: ApiDeps): ProjectIntegrationsService {
	if (!deps.integrations) {
		throw new NotFoundError('Integrations are not enabled on this deployment');
	}
	return deps.integrations;
}

function requireOrgIntegrations(deps: ApiDeps): OrgIntegrationsService {
	if (!deps.orgIntegrations) {
		throw new NotFoundError('Integrations are not enabled on this deployment');
	}
	return deps.orgIntegrations;
}

function entryResponse(e: IntegrationEntry) {
	return {
		id: e.id,
		kind: e.kind,
		name: e.name,
		enabled: e.enabled,
		current_version: e.current_version,
		created_by: e.created_by,
		created_at: e.created_at,
		updated_at: e.updated_at,
		scope: e.scope,
		...(e.shadowed !== undefined ? { shadowed: e.shadowed } : {}),
	};
}

function detailResponse(d: IntegrationDetail) {
	return {
		...entryResponse(d),
		config: d.config,
		...(d.change_note ? { change_note: d.change_note } : {}),
	};
}

const app = createApp();

app.openapi(listKinds, (c) => {
	const integrations = requireIntegrations(c.get('deps'));
	return c.json({ success: true as const, data: integrations.listKinds() }, 200);
});

app.openapi(listIntegrations, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.read', deps.policy);
	const data = paginate((await integrations.list(pid)).map(entryResponse), query, {
		key: (entry) => entry.updated_at,
		tiebreak: (entry) => entry.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.create(pid, body, user.id);
	// Audit trail (kind/name only — never config). Best-effort; never fail the write.
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.create',
		() =>
			deps.services.events.append({
				event: 'integration.create',
				actor: user.id,
				project_id: pid,
				integration_scope: 'project',
				integration_id: detail.id,
				integration_kind: detail.kind,
				integration_name: detail.name,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(getIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.read', deps.policy);
	const detail = await integrations.get(pid, iid);
	c.header('ETag', etagFor(detail.updated_at));
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(updateIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.update(pid, iid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(detail.updated_at));
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.update',
		() =>
			deps.services.events.append({
				event: 'integration.update',
				actor: user.id,
				project_id: pid,
				integration_scope: 'project',
				integration_id: iid,
				integration_kind: detail.kind,
				integration_name: detail.name,
				config_changed: body.config !== undefined,
				current_version: detail.current_version,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(deleteIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps.policy);
	// A no-op delete (already gone, or an id from the org tier) still succeeds
	// but must not fabricate an audit-trail deletion.
	const deleted = await integrations.delete(pid, iid, ifMatchToken(c));
	if (deleted) {
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'integration.delete',
			() =>
				deps.services.events.append({
					event: 'integration.delete',
					actor: user.id,
					project_id: pid,
					integration_scope: 'project',
					integration_id: iid,
				}),
		);
	}
	return c.json({ success: true }, 200);
});

app.openapi(listIntegrationVersions, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.read', deps.policy);
	// Paged in the store rather than by `paginate`: it reads only this page's
	// records, never the whole (unbounded) history.
	const page = await integrations.listVersions(pid, iid, {
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		cursor: query.cursor,
	});
	return c.json({ success: true, data: page }, 200);
});

// The probe is a server-side request forger by construction, so beside the
// probe's own global cap, each USER gets a sliding-window budget — one manager
// cannot starve every other tenant on the replica.
const BUDGET_WINDOW_MS = 60_000;

function createUserBudget(limit: number): SlidingWindowBudget<string> {
	return createSlidingWindowBudget({ limit, windowMs: BUDGET_WINDOW_MS });
}

function assertBudget(budget: SlidingWindowBudget<string>, userId: string, message: string): void {
	if (!budget.consume(userId)) throw new ResourceExhaustedError(message);
}

const testBudget = createUserBudget(10);
function assertTestBudget(userId: string): void {
	assertBudget(testBudget, userId, 'Too many connection tests — try again in a minute.');
}

export function trackedTestBudgets(): number {
	return testBudget.tracked();
}

app.openapi(copyIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	const body = c.req.valid('json');
	// The copy moves decrypted secret material across the project boundary, so
	// the caller must hold manager on BOTH sides (a super admin is admin
	// everywhere). Destination first: its 404/403 must not confirm the source.
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps.policy);
	// Visibility before role for the SOURCE: any destination manager can probe an
	// arbitrary id here, so a project the caller cannot see answers the same 404
	// as one that does not exist; 403 is reserved for projects they can see.
	const source = await loadVisibleProject(
		deps.services.projects,
		body.source_project_id,
		user,
		deps.policy,
	);
	await assertProjectActionOn(source, user, 'integration.manage', deps.policy);
	const detail = await integrations.copy(
		body.source_project_id,
		body.source_integration_id,
		pid,
		{ name: body.name },
		user.id,
	);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.copy',
		() =>
			deps.services.events.append({
				event: 'integration.copy',
				actor: user.id,
				project_id: pid,
				integration_scope: 'project',
				integration_id: detail.id,
				integration_kind: detail.kind,
				integration_name: detail.name,
				source_project_id: body.source_project_id,
				source_integration_id: body.source_integration_id,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(testIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'integration.manage',
		deps.policy,
	);
	assertTestBudget(user.id);
	const body = c.req.valid('json') as TestIntegrationRequest;
	const objectContext = await objectTestContext(
		integrations.listKinds(),
		body,
		(id) => integrations.get(pid, id),
		() => makeObjectBrowseContext(deps, project, user, c.req.raw.signal),
	);
	return c.json({ success: true, data: await integrations.test(pid, body, objectContext) }, 200);
});

app.openapi(queryReadiness, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.manage', deps.policy);
	const body = c.req.valid('json') as QueryReadinessRequest;
	return c.json({ success: true, data: integrations.queryReadiness(body) }, 200);
});

app.route('/', integrationBrowseApp);

app.openapi(listOrgIntegrations, async (c) => {
	const deps = c.get('deps');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(c.get('user'), deps.policy);
	const query = c.req.valid('query');
	const data = paginate((await integrations.list()).map(entryResponse), query, {
		key: (entry) => entry.updated_at,
		tiebreak: (entry) => entry.id,
	});
	return c.json({ success: true, data }, 200);
});

app.openapi(createOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(user, deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.create(body, user.id);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.create',
		() =>
			deps.services.events.append({
				event: 'integration.create',
				actor: user.id,
				integration_scope: 'org',
				integration_id: detail.id,
				integration_kind: detail.kind,
				integration_name: detail.name,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(getOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const { iid } = c.req.valid('param');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(c.get('user'), deps.policy);
	const detail = await integrations.get(iid);
	c.header('ETag', etagFor(detail.updated_at));
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(updateOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { iid } = c.req.valid('param');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(user, deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.update(iid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(detail.updated_at));
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'integration.update',
		() =>
			deps.services.events.append({
				event: 'integration.update',
				actor: user.id,
				integration_scope: 'org',
				integration_id: iid,
				integration_kind: detail.kind,
				integration_name: detail.name,
				config_changed: body.config !== undefined,
				current_version: detail.current_version,
			}),
	);
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(deleteOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { iid } = c.req.valid('param');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(user, deps.policy);
	const deleted = await integrations.delete(iid, ifMatchToken(c));
	if (deleted) {
		await appendAudit(
			{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
			'integration.delete',
			() =>
				deps.services.events.append({
					event: 'integration.delete',
					actor: user.id,
					integration_scope: 'org',
					integration_id: iid,
				}),
		);
	}
	return c.json({ success: true }, 200);
});

app.openapi(listOrgIntegrationVersions, async (c) => {
	const deps = c.get('deps');
	const { iid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(c.get('user'), deps.policy);
	const page = await integrations.listVersions(iid, {
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		cursor: query.cursor,
	});
	return c.json({ success: true, data: page }, 200);
});

app.openapi(testOrgIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(user, deps.policy);
	assertTestBudget(user.id);
	const body = c.req.valid('json') as TestIntegrationRequest;
	const objectContext = await objectTestContext(
		integrations.listKinds(),
		body,
		(id) => integrations.get(id),
		() =>
			Promise.resolve({
				user_id: user.id,
				user_email: user.email,
				allow_server_ambient: {
					s3: deps.dataBrowser?.objectBrowser?.allowServerAmbientCredentials ?? false,
					gcs: deps.dataBrowser?.objectBrowser?.allowServerAmbientCredentials ?? false,
					azure_blob: deps.dataBrowser?.objectBrowser?.allowServerAmbientCredentials ?? false,
				},
				signal: c.req.raw.signal,
			}),
	);
	return c.json({ success: true, data: await integrations.test(body, objectContext) }, 200);
});

app.openapi(queryOrgReadiness, async (c) => {
	const deps = c.get('deps');
	const integrations = requireOrgIntegrations(deps);
	await assertSuperAdmin(c.get('user'), deps.policy);
	const body = c.req.valid('json') as QueryReadinessRequest;
	return c.json({ success: true, data: integrations.queryReadiness(body) }, 200);
});

async function objectTestContext(
	kinds: ReturnType<ProjectIntegrationsService['listKinds']>,
	request: TestIntegrationRequest,
	getStored: (id: IntegrationId) => Promise<IntegrationDetail>,
	makeContext: () => Promise<ObjectBrowseContext>,
): Promise<ObjectBrowseContext | undefined> {
	const kind = request.source === 'draft' ? request.kind : (await getStored(request.id)).kind;
	if (!kinds.find((item) => item.kind === kind)?.browse_surfaces.includes('objects')) {
		return undefined;
	}
	return makeContext();
}

export default app;
