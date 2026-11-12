import { createRoute, z } from '@hono/zod-openapi';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { NotFoundError, ResourceExhaustedError } from '@marimo-hub/core';
import {
	assertSessionAuthenticated,
	createApp,
	errorResponses,
	jsonContent,
	SESSION_ONLY_SECURITY,
} from '../shared';

const app = createApp();
function linkCookie(redirectUri: string) {
	const secure = new URL(redirectUri).protocol === 'https:';
	return {
		name: secure ? '__Host-marimohub_github_link' : 'marimohub_github_link',
		options: { secure, path: '/', httpOnly: true, sameSite: 'Lax' as const },
	};
}
const accountSchema = z.object({
	login: z.string(),
	account_id: z.string(),
	connected: z.boolean(),
});
const response = <T extends z.ZodType>(data: T) =>
	jsonContent(z.object({ success: z.literal(true), data }), 'GitHub connection');
const common = { tags: ['Auth'], security: SESSION_ONLY_SECURITY, 'x-cli-hidden': true };

app.use('/me/github*', async (c, next) => {
	c.header('Cache-Control', 'no-store');
	c.header('Referrer-Policy', 'no-referrer');
	await next();
});
app.openapi(
	createRoute({
		...common,
		method: 'get',
		path: '/me/github',
		operationId: 'auth.github.status',
		responses: {
			200: response(z.object({ enabled: z.boolean(), account: accountSchema.nullable() })),
			...errorResponses(401, 403),
		},
	}),
	async (c) => {
		assertSessionAuthenticated(c, 'manage your GitHub connection');
		const deps = c.get('deps');
		const account = (await deps.githubAccounts?.status(c.get('user').id)) ?? null;
		return c.json({
			success: true as const,
			data: { enabled: deps.githubPublishActor === 'user', account },
		});
	},
);
app.openapi(
	createRoute({
		...common,
		method: 'post',
		path: '/me/github/connect',
		operationId: 'auth.github.connect',
		responses: {
			200: response(z.object({ url: z.string() })),
			...errorResponses(401, 403, 404, 429),
		},
	}),
	async (c) => {
		assertSessionAuthenticated(c, 'connect your GitHub account');
		const deps = c.get('deps'),
			accounts = deps.githubAccounts;
		if (!accounts || deps.githubPublishActor !== 'user')
			throw new NotFoundError('Personal GitHub publishing is not enabled');
		const browser = crypto.randomUUID();
		const url = await accounts.begin(c.get('user').id, browser);
		const cookie = linkCookie(accounts.redirectUri);
		setCookie(c, cookie.name, browser, {
			...cookie.options,
			maxAge: 600,
		});
		return c.json({ success: true as const, data: { url } });
	},
);
app.openapi(
	createRoute({
		...common,
		method: 'get',
		path: '/me/github/callback',
		operationId: 'auth.github.callback',
		request: {
			query: z.object({
				code: z.string().min(1).max(1024).optional(),
				error: z.string().max(128).optional(),
				state: z.string().min(1).max(128).optional(),
			}),
		},
		responses: {
			302: { description: 'GitHub account connected' },
			...errorResponses(400, 401, 403, 404, 429),
		},
	}),
	async (c) => {
		assertSessionAuthenticated(c, 'connect your GitHub account');
		const deps = c.get('deps'),
			accounts = deps.githubAccounts;
		if (!accounts || deps.githubPublishActor !== 'user')
			throw new NotFoundError('Personal GitHub publishing is not enabled');
		if (!(await deps.services.oauthRateLimits.consume('authorize')))
			throw new ResourceExhaustedError('Too many GitHub authorization callbacks');
		const cookie = linkCookie(accounts.redirectUri);
		const browser = getCookie(c, cookie.name);
		const { code, state, error } = c.req.valid('query');
		let connected = false;
		if (browser && !error && code && state) {
			try {
				await accounts.complete(c.get('user').id, browser, state, code);
				connected = true;
			} catch {
				/* The clean redirect never exposes provider errors or OAuth parameters. */
			}
		}
		deleteCookie(c, cookie.name, cookie.options);
		return c.redirect(connected ? '/account/github' : '/account/github?connection=failed', 302);
	},
);
app.openapi(
	createRoute({
		...common,
		method: 'delete',
		path: '/me/github',
		operationId: 'auth.github.disconnect',
		responses: {
			200: response(z.object({ remote_revocation_confirmed: z.boolean() })),
			...errorResponses(401, 403, 404),
		},
	}),
	async (c) => {
		assertSessionAuthenticated(c, 'disconnect your GitHub account');
		const accounts = c.get('deps').githubAccounts;
		if (!accounts) throw new NotFoundError('GitHub account management is not configured');
		const result = await accounts.disconnect(c.get('user').id);
		const cookie = linkCookie(accounts.redirectUri);
		deleteCookie(c, cookie.name, cookie.options);
		return c.json({ success: true as const, data: result });
	},
);
export default app;
