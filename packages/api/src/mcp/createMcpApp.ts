import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mcpAuthRouter, StreamableHTTPTransport } from '@hono/mcp';
import type { ApiDeps, HonoEnv } from '../context';
import { authenticateMcpRequest } from './auth';
import { createOAuthProvider } from './oauthProvider';
import { createMcpServer } from './server';
import { MCP_SCOPES } from './constants';

function rateLimited(c: { json(body: unknown, status: 429): Response }): Response {
	return c.json({ error: 'too_many_requests', error_description: 'Try again later' }, 429);
}

export function createMcpApp(deps: ApiDeps): Hono<HonoEnv> {
	const app = new Hono<HonoEnv>();
	if (!deps.mcp) return app;
	const { publicBaseUrl } = deps.mcp;
	const resource = `${publicBaseUrl}/mcp`;
	const baseUrl = new URL(publicBaseUrl);
	const provider = createOAuthProvider(deps);
	const protectedResourceMetadata = {
		resource,
		authorization_servers: [publicBaseUrl],
		bearer_methods_supported: ['header'],
		resource_name: 'marimohub',
		scopes_supported: MCP_SCOPES,
	};

	app.use('/register', async (c, next) => {
		if (!(await deps.services.oauthRateLimits.consume('register'))) return rateLimited(c);
		await next();
	});
	app.use('/authorize', async (c, next) => {
		if (!(await deps.services.oauthRateLimits.consume('authorize'))) return rateLimited(c);
		await next();
	});
	app.use('/token', async (c, next) => {
		if (!(await deps.services.oauthRateLimits.consume('token'))) return rateLimited(c);
		await next();
	});
	app.use('/revoke', async (c, next) => {
		if (!(await deps.services.oauthRateLimits.consume('revoke'))) return rateLimited(c);
		await next();
	});
	app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata));
	app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata));
	app.get('/.well-known/oauth-authorization-server', (c) =>
		c.json({
			issuer: publicBaseUrl,
			authorization_endpoint: `${publicBaseUrl}/authorize`,
			token_endpoint: `${publicBaseUrl}/token`,
			registration_endpoint: `${publicBaseUrl}/register`,
			revocation_endpoint: `${publicBaseUrl}/revoke`,
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			grant_types_supported: ['authorization_code'],
			revocation_endpoint_auth_methods_supported: ['none'],
			scopes_supported: MCP_SCOPES,
		}),
	);
	app.post('/revoke', async (c) => {
		c.header('Cache-Control', 'no-store');
		const body = await c.req.parseBody();
		const token = body.token;
		const clientId = body.client_id;
		if (typeof token !== 'string' || typeof clientId !== 'string') {
			return c.json(
				{ error: 'invalid_request', error_description: 'token and client_id are required' },
				400,
			);
		}
		const client = await provider.clientsStore.getClient(clientId);
		if (!client) return c.json({ error: 'invalid_client' }, 400);
		await provider.revokeToken?.(client, {
			token,
			...(typeof body.token_type_hint === 'string'
				? { token_type_hint: body.token_type_hint }
				: {}),
		});
		return c.json({});
	});
	app.route(
		'/',
		mcpAuthRouter({
			provider,
			issuerUrl: publicBaseUrl,
			baseUrl,
			resourceServerUrl: new URL(resource),
			resourceName: 'marimohub',
			scopesSupported: MCP_SCOPES,
			clientRegistrationOptions: { clientIdGeneration: false, rateLimit: false },
			authorizationOptions: { rateLimit: false },
			tokenOptions: { rateLimit: false },
			revocationOptions: { rateLimit: false },
		}),
	);
	app.use(
		'/mcp',
		cors({
			origin: '*',
			allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
		}),
	);
	app.all('/mcp', async (c) => {
		const authenticated = await authenticateMcpRequest(c, deps);
		if (authenticated instanceof Response) return authenticated;
		const server = createMcpServer(deps, authenticated, {
			requestId: c.get('requestId'),
			method: c.req.method,
			path: c.req.path,
			hostname: new URL(c.req.url).hostname,
			appBaseUrl: publicBaseUrl,
		});
		const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
		await server.connect(transport);
		return transport.handleRequest(c);
	});

	return app;
}
