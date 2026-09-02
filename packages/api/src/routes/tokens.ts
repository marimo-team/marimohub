import { createRoute, z } from '@hono/zod-openapi';
import { TokenGrantSchema, TokenId } from '@marimo-hub/core';
import type { CreatedToken, PublicToken } from '@marimo-hub/core';
import { appendAudit } from '../log';
import { auditTokenCreation } from '../tokenAudit';
import {
	assertSessionAuthenticated,
	assertTokenGrantProjectsVisible,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	SESSION_ONLY_SECURITY,
	SuccessResponseSchema,
} from '../shared';

// --- Schemas ---

const TokenResponseSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		created_at: z.string().openapi({ format: 'date-time' }),
		expires_at: z.string().openapi({ format: 'date-time' }).optional(),
		/** Coarse (daily) usage marker; absent until the token is first used. */
		last_used_at: z.string().openapi({ format: 'date-time' }).optional(),
		grant: TokenGrantSchema.optional(),
	})
	.openapi('ApiToken');

const TokenCreatedResponseSchema = TokenResponseSchema.extend({
	/** The plaintext token, returned exactly once — only its hash is stored. */
	token: z.string(),
}).openapi('ApiTokenCreated');

const CreateTokenBodySchema = z.strictObject({
	// Trim first so a whitespace-only name fails the non-empty check (mirrors the
	// UI) and the stored name has no leading/trailing padding.
	name: z.string().trim().min(1).max(100).openapi({ example: 'ci-deploy' }),
	expires_in_days: z.number().int().min(1).max(3650).optional().openapi({
		description: 'Days until expiry; omit for a non-expiring token.',
		example: 90,
	}),
});

const CreateScopedTokenBodySchema = CreateTokenBodySchema.extend({
	grant: TokenGrantSchema,
});

const TokenIdParam = z.object({
	tokenId: z
		.string()
		.regex(TokenId.regex)
		.refine(TokenId.is)
		.openapi({ param: { name: 'tokenId', in: 'path' }, example: '01HXY0S6GWMBASVAG3PZ7Y2K5T' }),
});

// --- Route definitions ---

const createToken = createRoute({
	method: 'post',
	path: '/me/tokens',
	operationId: 'auth.tokens.create',
	tags: ['Auth'],
	summary: 'Create a personal access token',
	description:
		'Mint a machine credential that acts as the calling user (CI, scripts, the CLI): send it as ' +
		'`Authorization: Bearer mhub_pat_…`. The plaintext token is returned once, in this response, ' +
		'and never again. Requires session (SSO) auth — a token cannot mint tokens.',
	security: SESSION_ONLY_SECURITY,
	request: { body: jsonBody(CreateTokenBodySchema) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: TokenCreatedResponseSchema }),
			'The new token — copy it now; it is never shown again',
		),
		...commonErrors(),
		...errorResponses(403, 429),
	},
});

const createScopedToken = createRoute({
	method: 'post',
	path: '/me/tokens/scoped',
	operationId: 'auth.tokens.createScoped',
	tags: ['Auth'],
	summary: 'Create a scoped personal access token',
	description:
		'Mint a v2 personal access token with an immutable action and project grant. ' +
		'Selected projects must be visible to the caller when the token is created.',
	security: SESSION_ONLY_SECURITY,
	request: { body: jsonBody(CreateScopedTokenBodySchema) },
	responses: {
		201: jsonContent(
			z.object({ success: z.literal(true), data: TokenCreatedResponseSchema }),
			'The new token — copy it now; it is never shown again',
		),
		...commonErrors(),
		...errorResponses(403, 404, 429),
	},
});

const listTokens = createRoute({
	method: 'get',
	path: '/me/tokens',
	operationId: 'auth.tokens.list',
	tags: ['Auth'],
	summary: "List the caller's personal access tokens",
	description: 'Metadata only — the secret is never retrievable after creation.',
	security: SESSION_ONLY_SECURITY,
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(TokenResponseSchema) }),
			'Tokens, newest first',
		),
		...commonErrors(),
		...errorResponses(403),
	},
});

const revokeToken = createRoute({
	method: 'delete',
	path: '/me/tokens/{tokenId}',
	operationId: 'auth.tokens.revoke',
	tags: ['Auth'],
	summary: 'Revoke a personal access token',
	description:
		'Deletes the token; API requests using it fail within the verification-cache TTL ' +
		'(~30 seconds) on other replicas, immediately on this one.',
	security: SESSION_ONLY_SECURITY,
	request: { params: TokenIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Token revoked'),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

// --- App ---

// Explicit pick: the stored record also carries `user_id` (always the caller's
// own id on these self-service routes), which the response contract omits.
function toResponse(record: PublicToken) {
	return {
		id: record.id,
		name: record.name,
		created_at: record.created_at,
		...(record.expires_at !== undefined ? { expires_at: record.expires_at } : {}),
		...(record.last_used_at !== undefined ? { last_used_at: record.last_used_at } : {}),
		...(record.grant !== undefined ? { grant: record.grant } : {}),
	};
}

function createdTokenData({ token, record }: CreatedToken) {
	return { ...toResponse(record), token };
}

const app = createApp();

app.openapi(createToken, async (c) => {
	assertSessionAuthenticated(c, 'manage tokens');
	const deps = c.get('deps');
	const user = c.get('user');
	const { name, expires_in_days } = c.req.valid('json');

	const credential = await deps.services.tokens.create(
		{ name, expiresInDays: expires_in_days },
		user.id,
	);
	await auditTokenCreation(c, credential);
	return c.json({ success: true as const, data: createdTokenData(credential) }, 201);
});

app.openapi(createScopedToken, async (c) => {
	assertSessionAuthenticated(c, 'manage tokens');
	const deps = c.get('deps');
	const user = c.get('user');
	const { name, expires_in_days, grant } = c.req.valid('json');
	await assertTokenGrantProjectsVisible(deps, user, grant);

	const credential = await deps.services.tokens.create(
		{ name, expiresInDays: expires_in_days, grant },
		user.id,
	);
	await auditTokenCreation(c, credential);
	return c.json({ success: true as const, data: createdTokenData(credential) }, 201);
});

app.openapi(listTokens, async (c) => {
	assertSessionAuthenticated(c, 'manage tokens');
	const deps = c.get('deps');
	const user = c.get('user');
	const records = await deps.services.tokens.list(user.id);
	return c.json({ success: true, data: records.map(toResponse) }, 200);
});

app.openapi(revokeToken, async (c) => {
	assertSessionAuthenticated(c, 'manage tokens');
	const deps = c.get('deps');
	const user = c.get('user');
	const { tokenId } = c.req.valid('param');

	await deps.services.tokens.revoke(user.id, tokenId);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'token.revoke',
		() =>
			deps.services.events.append({
				event: 'token.revoke',
				actor: user.id,
				token_id: tokenId,
			}),
	);
	return c.json({ success: true }, 200);
});

export default app;
