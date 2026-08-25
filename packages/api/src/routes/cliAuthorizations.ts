import { createRoute, z } from '@hono/zod-openapi';
import {
	BadRequestError,
	createSlidingWindowBudget,
	ResourceExhaustedError,
} from '@marimo-hub/core';
import { appendAudit } from '../log';
import {
	assertSessionAuthenticated,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	SESSION_ONLY_SECURITY,
} from '../shared';

const CallbackUriSchema = z.url().max(300);
const StateSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const CodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const ApproveBodySchema = z.object({
	callback_uri: CallbackUriSchema,
	state: StateSchema,
	code_challenge: CodeChallengeSchema,
	token_name: z.string().trim().min(1).max(100),
	expires_in_days: z.number().int().min(1).max(3650),
});

const ExchangeBodySchema = z.object({
	code: z.string().min(1).max(100),
	code_verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
});

const AUTHORIZATION_EXCHANGE_LIMIT = 5;
const GLOBAL_EXCHANGE_LIMIT = 600;
const EXCHANGE_WINDOW_MS = 60_000;
const AUTHORIZATION_CODE_RE = /^mhub_cli_([0-9A-Z]{26})_[0-9a-z]{32}$/;
const authorizationExchangeBudget = createSlidingWindowBudget<string>({
	limit: AUTHORIZATION_EXCHANGE_LIMIT,
	windowMs: EXCHANGE_WINDOW_MS,
});
const globalExchangeBudget = createSlidingWindowBudget<'deployment'>({
	limit: GLOBAL_EXCHANGE_LIMIT,
	windowMs: EXCHANGE_WINDOW_MS,
});

function assertExchangeAllowed(code: string): void {
	const authorizationId = AUTHORIZATION_CODE_RE.exec(code)?.[1];
	if (authorizationId === undefined) return;
	if (!authorizationExchangeBudget.consume(authorizationId)) {
		throw new ResourceExhaustedError('Too many attempts for this CLI authorization code.');
	}
	if (!globalExchangeBudget.consume('deployment')) {
		throw new ResourceExhaustedError('Too many CLI token exchanges; try again later.');
	}
}

function loopbackCallback(raw: string): URL {
	const url = new URL(raw);
	const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	if (
		url.protocol !== 'http:' ||
		!loopback ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== '/callback' ||
		url.search ||
		url.hash
	) {
		throw new BadRequestError('callback_uri must be an HTTP loopback URL ending in /callback');
	}
	return url;
}

const approveAuthorization = createRoute({
	method: 'post',
	path: '/me/cli-authorizations',
	operationId: 'auth.cli.approve',
	'x-cli-hidden': true,
	tags: ['Auth'],
	summary: 'Approve a CLI login',
	description:
		'Creates a short-lived, one-time authorization code bound to the CLI PKCE challenge. ' +
		'Requires a browser session; the personal access token is minted only during exchange.',
	security: SESSION_ONLY_SECURITY,
	request: { body: jsonBody(ApproveBodySchema) },
	responses: {
		201: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({
					redirect_uri: z.url(),
					expires_at: z.string().openapi({ format: 'date-time' }),
				}),
			}),
			'Loopback callback carrying the one-time authorization code',
		),
		...commonErrors(),
		...errorResponses(400, 403, 429),
	},
});

const exchangeAuthorization = createRoute({
	method: 'post',
	path: '/token',
	operationId: 'auth.cli.exchange',
	'x-cli-hidden': true,
	tags: ['Auth'],
	summary: 'Exchange a CLI authorization code',
	description:
		'Public PKCE exchange for the mohub loopback login. The authorization code is single-use, ' +
		'short-lived, and useless without the verifier held by the CLI.',
	security: [],
	request: { body: jsonBody(ExchangeBodySchema) },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.object({ token: z.string() }),
			}),
			'The new personal access token',
		),
		...errorResponses(400, 413, 422, 429, 500, 503),
	},
});

const app = createApp();

app.openapi(approveAuthorization, async (c) => {
	assertSessionAuthenticated(c, 'approve CLI logins');
	const body = c.req.valid('json');
	const callback = loopbackCallback(body.callback_uri);
	const approved = await c.get('deps').services.cliAuthorizations.approve(
		{
			codeChallenge: body.code_challenge,
			tokenName: body.token_name,
			expiresInDays: body.expires_in_days,
		},
		c.get('user').id,
	);
	callback.searchParams.set('code', approved.code);
	callback.searchParams.set('state', body.state);
	c.header('Cache-Control', 'no-store');
	c.header('Pragma', 'no-cache');
	return c.json(
		{
			success: true as const,
			data: { redirect_uri: callback.toString(), expires_at: approved.expiresAt },
		},
		201,
	);
});

export const cliTokenApp = createApp();

cliTokenApp.openapi(exchangeAuthorization, async (c) => {
	const body = c.req.valid('json');
	const deps = c.get('deps');
	assertExchangeAllowed(body.code);
	const { token, record } = await deps.services.cliAuthorizations.exchange(
		body.code,
		body.code_verifier,
	);
	await appendAudit(
		{
			requestId: c.get('requestId'),
			method: c.req.method,
			path: c.req.path,
			userId: record.user_id,
		},
		'token.create',
		() =>
			deps.services.events.append({
				event: 'token.create',
				actor: record.user_id,
				token_id: record.id,
				token_name: record.name,
			}),
	);
	c.header('Cache-Control', 'no-store');
	c.header('Pragma', 'no-cache');
	return c.json({ success: true as const, data: { token } }, 200);
});

export default app;
