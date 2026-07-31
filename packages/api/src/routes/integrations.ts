import { createRoute, z } from '@hono/zod-openapi';
import {
	INTEGRATION_CATEGORIES,
	IntegrationId,
	NotFoundError,
	ResourceExhaustedError,
} from '@marimo-hub/core';
import type {
	IntegrationDetail,
	IntegrationEntry,
	IntegrationsProvider,
	TestIntegrationRequest,
} from '@marimo-hub/core';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	etagFor,
	EtagResponseHeader,
	IfMatchHeader,
	ifMatchToken,
	jsonBody,
	jsonContent,
	ProjectIdParam,
	SuccessResponseSchema,
} from '../shared';
import type { ApiDeps } from '../shared';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageSchema, PaginationQuery } from '../pagination';

const IntegrationIdParam = ProjectIdParam.extend({
	iid: z
		.string()
		.regex(IntegrationId.regex)
		.refine(IntegrationId.is)
		.openapi({ param: { name: 'iid', in: 'path' }, example: 'intg-7h2k9qm4xz7rp3w8' }),
});

// Per-kind config shapes are dynamic (each kind owns a Zod schema, serialized to
// clients as `KindDescriptor.json_schema`), so the route layer types config as an
// open object and the store validates it against the kind's schema (→ 422).
const ConfigSchema = z.record(z.string(), z.unknown());

const KindDescriptorSchema = z
	.object({
		kind: z.string().openapi({ example: 'postgres' }),
		title: z.string(),
		description: z.string(),
		category: z.enum(INTEGRATION_CATEGORIES),
		schema_version: z.number().int(),
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
		/** Informational package requirements for the rendered sandbox contract. */
		requirements: z.array(z.string()),
	})
	.openapi('IntegrationKind');

const IntegrationEntrySchema = z
	.object({
		id: z.string(),
		kind: z.string(),
		name: z.string(),
		enabled: z.boolean(),
		current_version: z.number().int(),
		created_by: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.openapi('IntegrationEntry');

// `config` is ALWAYS the redacted shape: secret fields appear as
// `{ "$secret": { "set": true } }`, never as values or ciphertext.
const IntegrationDetailSchema = IntegrationEntrySchema.extend({
	config: ConfigSchema,
	change_note: z.string().optional(),
}).openapi('IntegrationDetail');

const IntegrationVersionSchema = z
	.object({
		version: z.number().int(),
		kind_schema_version: z.number().int(),
		created_by: z.string(),
		created_at: z.string(),
		change_note: z.string().optional(),
	})
	.openapi('IntegrationVersion');

const TestResultSchema = z
	.object({
		ok: z.boolean(),
		latency_ms: z.number().optional(),
		/** User-safe probe details; never secret material. */
		details: z.string().optional(),
	})
	.openapi('IntegrationTestResult');

const CreateIntegrationBody = z.object({
	kind: z.string().min(1),
	name: z.string().min(1).openapi({ example: 'prod' }),
	config: ConfigSchema,
	change_note: z.string().max(500).optional(),
});

const UpdateIntegrationBody = z
	.object({
		name: z.string().min(1).optional(),
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
	);

const TestIntegrationBody = z
	.union([
		z.object({ kind: z.string().min(1), config: ConfigSchema }),
		z.object({ id: z.string().regex(IntegrationId.regex).refine(IntegrationId.is) }),
	])
	.openapi('IntegrationTestRequest');

const listKinds = createRoute({
	method: 'get',
	path: '/integrations/kinds',
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
	tags: ['Integrations'],
	summary: "List a project's integrations",
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(IntegrationEntrySchema) }),
			'Integration instances (no config)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const createIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations',
	tags: ['Integrations'],
	summary: 'Create an integration (admin only)',
	request: { params: ProjectIdParam, body: jsonBody(CreateIntegrationBody) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: IntegrationDetailSchema }),
			'Integration created (config redacted)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const getIntegration = createRoute({
	method: 'get',
	path: '/projects/{pid}/integrations/{iid}',
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
	tags: ['Integrations'],
	summary: 'Update an integration (admin only); a config change appends a version',
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
	tags: ['Integrations'],
	summary: 'Delete an integration and its version history (admin only)',
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

const testIntegration = createRoute({
	method: 'post',
	path: '/projects/{pid}/integrations/test',
	tags: ['Integrations'],
	summary: 'Probe connectivity for an unsaved config or a stored instance (admin only)',
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

/** Returns 404 when integrations are disabled for the deployment. */
function requireIntegrations(deps: ApiDeps): IntegrationsProvider {
	if (!deps.integrations) {
		throw new NotFoundError('Integrations are not enabled on this deployment');
	}
	return deps.integrations;
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
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'viewer', deps.policy);
	const data = (await integrations.list(pid)).map(entryResponse);
	return c.json({ success: true, data }, 200);
});

app.openapi(createIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'admin', deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.create(pid, body, user.id);
	// Audit trail (kind/name only — never config). Best-effort; never fail the write.
	await deps.services.events
		.append({
			event: 'integration.create',
			actor: user.id,
			project_id: pid,
			integration_id: detail.id,
			integration_kind: detail.kind,
			integration_name: detail.name,
		})
		.catch(() => {});
	return c.json({ success: true, data: detailResponse(detail) }, 201);
});

app.openapi(getIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'viewer', deps.policy);
	const detail = await integrations.get(pid, iid);
	c.header('ETag', etagFor(detail.updated_at));
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(updateIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'admin', deps.policy);
	const body = c.req.valid('json');
	const detail = await integrations.update(pid, iid, body, user.id, ifMatchToken(c));
	c.header('ETag', etagFor(detail.updated_at));
	await deps.services.events
		.append({
			event: 'integration.update',
			actor: user.id,
			project_id: pid,
			integration_id: iid,
			integration_kind: detail.kind,
			integration_name: detail.name,
			config_changed: body.config !== undefined,
			current_version: detail.current_version,
		})
		.catch(() => {});
	return c.json({ success: true, data: detailResponse(detail) }, 200);
});

app.openapi(deleteIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'admin', deps.policy);
	await integrations.delete(pid, iid, ifMatchToken(c));
	await deps.services.events
		.append({ event: 'integration.delete', actor: user.id, project_id: pid, integration_id: iid })
		.catch(() => {});
	return c.json({ success: true }, 200);
});

app.openapi(listIntegrationVersions, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, iid } = c.req.valid('param');
	const query = c.req.valid('query');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'viewer', deps.policy);
	// Paged in the store rather than by `paginate`: it reads only this page's
	// records, never the whole (unbounded) history.
	const page = await integrations.listVersions(pid, iid, {
		limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
		cursor: query.cursor,
	});
	return c.json({ success: true, data: page }, 200);
});

// The probe is a server-side request forger by construction, so beside the
// probe's own global cap, each USER gets a sliding-window budget — one admin
// cannot starve every other tenant on the replica.
const TESTS_PER_USER_PER_MINUTE = 10;
const TEST_WINDOW_MS = 60_000;
const recentTestsByUser = new Map<string, number[]>();
let lastSweptAt = 0;

/**
 * Forget users whose window has fully expired, so the map tracks concurrent
 * probers rather than every user the replica has ever served. Driven by request
 * traffic and amortized to once per window — an interval would keep a timer (and
 * this module's state) alive with no request behind it, in tests and on Workers
 * alike.
 */
function sweepTestBudgets(now: number): void {
	if (now - lastSweptAt < TEST_WINDOW_MS) return;
	lastSweptAt = now;
	for (const [userId, timestamps] of recentTestsByUser) {
		if (timestamps.every((t) => now - t >= TEST_WINDOW_MS)) recentTestsByUser.delete(userId);
	}
}

function assertTestBudget(userId: string): void {
	const now = Date.now();
	sweepTestBudgets(now);
	const recent = (recentTestsByUser.get(userId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
	if (recent.length >= TESTS_PER_USER_PER_MINUTE) {
		throw new ResourceExhaustedError('Too many connection tests — try again in a minute.');
	}
	recent.push(now);
	recentTestsByUser.set(userId, recent);
}

/** How many users the probe limiter currently holds state for. */
export function trackedTestBudgets(): number {
	return recentTestsByUser.size;
}

app.openapi(testIntegration, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const integrations = requireIntegrations(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'admin', deps.policy);
	assertTestBudget(user.id);
	const body = c.req.valid('json') as TestIntegrationRequest;
	return c.json({ success: true, data: await integrations.test(pid, body) }, 200);
});

export default app;
