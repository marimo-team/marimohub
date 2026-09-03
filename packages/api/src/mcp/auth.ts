import type { Context } from 'hono';
import { bearerToken } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from '../context';
import { MCP_SCOPE } from './constants';

export interface BearerRequirements {
	resource?: string;
	scope?: string;
}

export async function authenticateBearer(
	deps: ApiDeps,
	request: Request,
	requirements: BearerRequirements = {},
): Promise<AuthenticatedPrincipal | null> {
	if (!bearerToken(request)) return null;
	const principal = await deps.authenticator.authenticate(request);
	if (principal?.credential.kind !== 'personal-access-token') return null;
	const oauth = principal.credential.oauth;
	if (requirements.resource !== undefined && oauth?.resource !== requirements.resource) return null;
	if (requirements.scope !== undefined && !oauth?.scopes.includes(requirements.scope)) return null;
	if (await deps.services.identities.isSuspended(principal.id)) return null;
	return principal;
}

export async function authenticateMcpRequest(
	c: Context<HonoEnv>,
	deps: ApiDeps,
): Promise<AuthenticatedPrincipal | Response> {
	const resource = `${deps.mcp?.publicBaseUrl ?? new URL(c.req.url).origin}/mcp`;
	const principal = await authenticateBearer(deps, c.req.raw, {
		resource,
		scope: MCP_SCOPE,
	});
	if (principal) return principal;
	const resourceMetadata = `${deps.mcp?.publicBaseUrl ?? new URL(c.req.url).origin}/.well-known/oauth-protected-resource/mcp`;
	return c.json(
		{ error: 'invalid_token', error_description: 'A valid bearer token is required' },
		401,
		{
			'WWW-Authenticate': `Bearer realm="mcp", error="invalid_token", resource_metadata="${resourceMetadata}"`,
		},
	);
}
