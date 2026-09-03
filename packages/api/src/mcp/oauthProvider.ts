import type { Context } from 'hono';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
	OAuthClientInformationFull,
	OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
	InvalidGrantError,
	InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { BadRequestError, TokenId } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from '../context';
import { logEvent } from '../log';
import { authenticateBearer } from './auth';

function honoContext(value: unknown): Context<HonoEnv> {
	return value as Context<HonoEnv>;
}

export function createOAuthProvider(deps: ApiDeps): OAuthServerProvider {
	if (!deps.mcp) throw new Error('MCP is not configured');
	const canonicalResource = `${deps.mcp.publicBaseUrl}/mcp`;
	return {
		clientsStore: {
			getClient: async (clientId) =>
				((await deps.services.oauthClients.get(clientId)) as OAuthClientInformationFull | null) ??
				undefined,
			registerClient: async (client) => {
				try {
					return (await deps.services.oauthClients.register({
						redirect_uris: client.redirect_uris,
						...(client.client_name ? { client_name: client.client_name } : {}),
						...(client.client_uri ? { client_uri: client.client_uri } : {}),
						...(client.scope ? { scope: client.scope } : {}),
						...(client.grant_types ? { grant_types: client.grant_types } : {}),
						...(client.response_types ? { response_types: client.response_types } : {}),
					})) as OAuthClientInformationFull;
				} catch (error) {
					if (error instanceof BadRequestError) throw new InvalidRequestError(error.message);
					throw error;
				}
			},
		},
		async authorize(client, params, response) {
			if (params.resource && params.resource.href !== canonicalResource) {
				throw new InvalidRequestError(`resource must be ${canonicalResource}`);
			}
			const pending = await deps.services.oauthAuthorizations.begin({
				clientId: client.client_id,
				...(client.client_name ? { clientName: client.client_name } : {}),
				...(client.client_uri ? { clientUri: client.client_uri } : {}),
				redirectUri: params.redirectUri,
				codeChallenge: params.codeChallenge,
				scopes: params.scopes ?? [],
				...(params.state !== undefined ? { state: params.state } : {}),
				...(params.resource ? { resource: params.resource.href } : {}),
			});
			const c = honoContext(response);
			c.res = c.redirect(`${deps.mcp?.publicBaseUrl}/oauth/consent?id=${pending.id}`);
		},
		async challengeForAuthorizationCode(client, authorizationCode) {
			try {
				return await deps.services.oauthAuthorizations.challengeFor(
					authorizationCode,
					client.client_id,
				);
			} catch (error) {
				if (error instanceof BadRequestError) throw new InvalidGrantError(error.message);
				throw error;
			}
		},
		async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
			try {
				const credential = await deps.services.oauthAuthorizations.exchange({
					code,
					clientId: client.client_id,
					...(redirectUri ? { redirectUri } : {}),
					...(resource ? { resource: resource.href } : {}),
				});
				const expiresAt = credential.record.expires_at;
				await deps.services.events
					.append({
						event: 'token.create',
						actor: credential.record.user_id,
						token_id: credential.record.id,
						token_name: credential.record.name,
						grant: credential.record.grant,
						source: 'mcp',
					})
					.catch((error) => {
						logEvent({
							level: 'error',
							event: 'audit_append_failed',
							operation: 'token.create',
							user: credential.record.user_id,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				return {
					access_token: credential.token,
					token_type: 'bearer',
					...(expiresAt
						? {
								expires_in: Math.max(
									0,
									Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
								),
							}
						: {}),
				};
			} catch (error) {
				if (error instanceof BadRequestError) throw new InvalidGrantError(error.message);
				throw error;
			}
		},
		async exchangeRefreshToken() {
			throw new InvalidGrantError('Refresh tokens are not supported');
		},
		async verifyAccessToken(token): Promise<AuthInfo> {
			const request = new Request(canonicalResource, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const principal = await authenticateBearer(deps, request);
			if (!principal) throw new InvalidGrantError('Access token is invalid or expired');
			return {
				token,
				clientId: 'marimohub',
				scopes: [],
				resource: new URL(canonicalResource),
				extra: { principal },
			};
		},
		async revokeToken(_client, request: OAuthTokenRevocationRequest) {
			const principal = await deps.services.tokens.verify(request.token);
			if (
				principal?.credential.kind !== 'personal-access-token' ||
				!TokenId.is(principal.credential.id)
			) {
				return;
			}
			await deps.services.tokens.revoke(principal.id, principal.credential.id);
		},
		skipLocalPkceValidation: false,
	};
}
