import { createRoute, z } from '@hono/zod-openapi';
import { ForbiddenError, TokenId } from '@marimo-hub/core';
import type { PublicToken } from '@marimo-hub/core';
import type { Context } from 'hono';
import type { HonoEnv } from '../context';
import {
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
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
	})
	.openapi('ApiToken');

const TokenCreatedResponseSchema = TokenResponseSchema.extend({
	/** The plaintext token, returned exactly once — only its hash is stored. */
	token: z.string(),
}).openapi('ApiTokenCreated');

const CreateTokenBodySchema = z.object({
	name: z.string().min(1).max(100).openapi({ example: 'ci-deploy' }),
	expires_in_days: z.number().int().min(1).max(3650).optional().openapi({
		description: 'Days until expiry; omit for a non-expiring token.',
		example: 90,
	}),
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
	tags: ['Auth'],
	summary: 'Create a personal access token',
	description:
		'Mint a machine credential that acts as the calling user (CI, scripts, the CLI): send it as ' +
		'`Authorization: Bearer mhub_pat_…`. The plaintext token is returned once, in this response, ' +
		'and never again. Requires session (SSO) auth — a token cannot mint tokens.',
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

const listTokens = createRoute({
	method: 'get',
	path: '/me/tokens',
	tags: ['Auth'],
	summary: "List the caller's personal access tokens",
	description: 'Metadata only — the secret is never retrievable after creation.',
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
	tags: ['Auth'],
	summary: 'Revoke a personal access token',
	description:
		'Deletes the token; API requests using it fail within the verification-cache TTL ' +
		'(~30 seconds) on other replicas, immediately on this one.',
	request: { params: TokenIdParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Token revoked'),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

// --- App ---

/**
 * Token-authenticated requests may not manage tokens: a leaked PAT must not
 * mint replacements or revoke its neighbors. Gate on the `authMethod` flag the
 * authN middleware set — not a re-parse of the Authorization header, which
 * would risk disagreeing with the authenticator over scheme casing/whitespace.
 */
function assertSessionAuthenticated(c: Context<HonoEnv>): void {
	if (c.get('authMethod') === 'pat') {
		throw new ForbiddenError('Personal access tokens cannot manage tokens — sign in to do this');
	}
}

// Explicit pick: the stored record also carries `user_id` (always the caller's
// own id on these self-service routes), which the response contract omits.
function toResponse(record: PublicToken) {
	return {
		id: record.id,
		name: record.name,
		created_at: record.created_at,
		...(record.expires_at !== undefined ? { expires_at: record.expires_at } : {}),
		...(record.last_used_at !== undefined ? { last_used_at: record.last_used_at } : {}),
	};
}

const app = createApp();

app.openapi(createToken, async (c) => {
	assertSessionAuthenticated(c);
	const deps = c.get('deps');
	const user = c.get('user');
	const { name, expires_in_days } = c.req.valid('json');

	const { token, record } = await deps.services.tokens.create(
		{ name, expiresInDays: expires_in_days },
		user.id,
	);
	await deps.services.events
		.append({ event: 'token.created', actor: user.id, token_id: record.id, token_name: name })
		.catch(() => {});
	return c.json({ success: true, data: { ...toResponse(record), token } }, 201);
});

app.openapi(listTokens, async (c) => {
	assertSessionAuthenticated(c);
	const deps = c.get('deps');
	const user = c.get('user');
	const records = await deps.services.tokens.list(user.id);
	return c.json({ success: true, data: records.map(toResponse) }, 200);
});

app.openapi(revokeToken, async (c) => {
	assertSessionAuthenticated(c);
	const deps = c.get('deps');
	const user = c.get('user');
	const { tokenId } = c.req.valid('param');

	await deps.services.tokens.revoke(user.id, tokenId);
	await deps.services.events
		.append({ event: 'token.revoked', actor: user.id, token_id: tokenId })
		.catch(() => {});
	return c.json({ success: true }, 200);
});

export default app;
