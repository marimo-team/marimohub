import type { Context } from 'hono';
import { bearerToken } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from '../context';

export async function authenticateBearer(
	deps: ApiDeps,
	request: Request,
): Promise<AuthenticatedPrincipal | null> {
	if (!bearerToken(request)) return null;
	const principal = await deps.authenticator.authenticate(request);
	if (principal?.credential.kind !== 'personal-access-token') return null;
	if (await deps.services.identities.isSuspended(principal.id)) return null;
	return principal;
}

export async function authenticateMcpRequest(
	c: Context<HonoEnv>,
	deps: ApiDeps,
): Promise<AuthenticatedPrincipal | Response> {
	const principal = await authenticateBearer(deps, c.req.raw);
	if (principal) return principal;
	const resourceMetadata = `${deps.mcp?.publicBaseUrl ?? new URL(c.req.url).origin}/.well-known/oauth-protected-resource/mcp`;
	return c.json(
		{ error: 'invalid_token', error_description: 'A valid bearer token is required' },
		401,
		{
			'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"`,
		},
	);
}
