import { createRoute, z } from '@hono/zod-openapi';
import {
	createSlidingWindowBudget,
	NotFoundError,
	OAuthAuthorizationId,
	ResourceExhaustedError,
	TokenGrantSchema,
} from '@marimo-hub/core';
import {
	assertSessionAuthenticated,
	assertTokenGrantProjectsVisible,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	SESSION_ONLY_SECURITY,
} from '../shared';

const IdParamsSchema = z.object({ id: z.string().regex(OAuthAuthorizationId.regex) });
const PreviewSchema = z.object({
	client_name: z.string(),
	client_uri: z.string().optional(),
	redirect_uri: z.string(),
	scopes: z.array(z.string()),
	expires_at: z.string().openapi({ format: 'date-time' }),
});
const ApproveBodySchema = z.strictObject({
	grant: TokenGrantSchema,
	token_name: z.string().trim().min(1).max(100).optional(),
	expires_in_days: z.number().int().min(1).max(3650),
});
const RedirectSchema = z.object({ redirect_uri: z.string() });
const authorizationBudget = createSlidingWindowBudget<string>({ limit: 30, windowMs: 60_000 });

function requireMcp(deps: { mcp?: unknown }): void {
	if (!deps.mcp) throw new NotFoundError('MCP is not enabled');
}

function consume(userId: string): void {
	if (!authorizationBudget.consume(userId)) {
		throw new ResourceExhaustedError('Too many OAuth authorization requests; try again later.');
	}
}

function preventCaching(c: { header(name: string, value: string): void }): void {
	c.header('Cache-Control', 'no-store');
	c.header('Pragma', 'no-cache');
}

const previewRoute = createRoute({
	method: 'get',
	path: '/me/oauth-authorizations/{id}',
	operationId: 'auth.oauth.preview',
	'x-cli-hidden': true,
	tags: ['Auth'],
	security: SESSION_ONLY_SECURITY,
	request: { params: IdParamsSchema },
	responses: {
		200: jsonContent(z.object({ success: z.literal(true), data: PreviewSchema }), 'OAuth request'),
		...errorResponses(400, 401, 403, 404, 429),
	},
});

const approveRoute = createRoute({
	method: 'post',
	path: '/me/oauth-authorizations/{id}/approve',
	operationId: 'auth.oauth.approve',
	'x-cli-hidden': true,
	tags: ['Auth'],
	security: SESSION_ONLY_SECURITY,
	request: { params: IdParamsSchema, body: jsonBody(ApproveBodySchema) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: RedirectSchema }),
			'OAuth redirect',
		),
		...errorResponses(400, 401, 403, 404, 422, 429),
	},
});

const denyRoute = createRoute({
	method: 'post',
	path: '/me/oauth-authorizations/{id}/deny',
	operationId: 'auth.oauth.deny',
	'x-cli-hidden': true,
	tags: ['Auth'],
	security: SESSION_ONLY_SECURITY,
	request: { params: IdParamsSchema },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: RedirectSchema }),
			'OAuth redirect',
		),
		...errorResponses(400, 401, 403, 404, 429),
	},
});

const app = createApp();

app.openapi(previewRoute, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	requireMcp(deps);
	assertSessionAuthenticated(c, 'approve MCP connections');
	consume(user.id);
	const preview = await deps.services.oauthAuthorizations.preview(
		OAuthAuthorizationId.parse(c.req.valid('param').id),
	);
	preventCaching(c);
	return c.json({
		success: true as const,
		data: {
			client_name: preview.clientName,
			...(preview.clientUri ? { client_uri: preview.clientUri } : {}),
			redirect_uri: preview.redirectUri,
			scopes: preview.scopes,
			expires_at: preview.expiresAt,
		},
	});
});

app.openapi(approveRoute, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	requireMcp(deps);
	assertSessionAuthenticated(c, 'approve MCP connections');
	consume(user.id);
	const body = c.req.valid('json');
	await assertTokenGrantProjectsVisible(deps, user, body.grant);
	const authorizationId = OAuthAuthorizationId.parse(c.req.valid('param').id);
	const preview = await deps.services.oauthAuthorizations.preview(authorizationId);
	const result = await deps.services.oauthAuthorizations.approve(
		authorizationId,
		{
			grant: body.grant,
			tokenName: body.token_name ?? `MCP · ${preview.clientName}`.slice(0, 100),
			expiresInDays: body.expires_in_days,
		},
		user.id,
	);
	preventCaching(c);
	return c.json({ success: true as const, data: { redirect_uri: result.redirectUri } });
});

app.openapi(denyRoute, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	requireMcp(deps);
	assertSessionAuthenticated(c, 'deny MCP connections');
	consume(user.id);
	const result = await deps.services.oauthAuthorizations.deny(
		OAuthAuthorizationId.parse(c.req.valid('param').id),
	);
	preventCaching(c);
	return c.json({ success: true as const, data: { redirect_uri: result.redirectUri } });
});

export default app;
