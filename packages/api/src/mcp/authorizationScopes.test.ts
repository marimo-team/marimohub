import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createApi } from '../createApi';
import { makeTestDeps } from '../testing';

describe('MCP authorization scopes', () => {
	it.each(['', '/hub'])(
		'starts external SDK authorization with read access at prefix %j',
		async (prefix) => {
			const publicBaseUrl = `https://hub.example.com${prefix}`;
			const issuer = 'https://issuer.example.com';
			const deps = makeTestDeps(new MemoryBucket(), {
				mcp: { publicBaseUrl, externalAuthorizationServer: issuer },
			});
			deps.authenticator = { authenticate: async () => null };
			const app = createApi(deps);
			const redirectToAuthorization = vi.fn<(url: URL) => void>();
			const provider: OAuthClientProvider = {
				redirectUrl: 'https://client.example.com/callback',
				clientMetadata: {
					redirect_uris: ['https://client.example.com/callback'],
					token_endpoint_auth_method: 'none',
				},
				clientInformation: vi.fn(),
				saveClientInformation: vi.fn(),
				tokens: vi.fn(),
				saveTokens: vi.fn(),
				redirectToAuthorization,
				saveCodeVerifier: vi.fn(),
				codeVerifier: () => '',
			};
			const registration = vi.fn<(body: unknown) => void>();
			const transport = new StreamableHTTPClientTransport(new URL(`${publicBaseUrl}/mcp`), {
				authProvider: provider,
				fetch: async (input, init) => {
					const url = new URL(input instanceof Request ? input.url : input);
					if (url.origin === 'https://hub.example.com') {
						expect(url.pathname.startsWith(`${prefix}/`)).toBe(true);
						return app.request(url.pathname.slice(prefix.length), init);
					}
					expect(url.origin).toBe(issuer);
					if (url.pathname === '/register') {
						const body = JSON.parse(String(init?.body));
						registration(body);
						return Response.json({ ...provider.clientMetadata, client_id: 'test-client' });
					}
					expect(url.pathname).toBe('/.well-known/oauth-authorization-server');
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
						registration_endpoint: `${issuer}/register`,
						response_types_supported: ['code'],
						code_challenge_methods_supported: ['S256'],
					});
				},
			});
			try {
				await transport.start();
				await expect(
					transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
				).rejects.toBeInstanceOf(UnauthorizedError);
				expect(registration).toHaveBeenCalledWith(
					expect.objectContaining({ scope: 'mcp:tools marimohub:read' }),
				);
				expect(redirectToAuthorization).toHaveBeenCalledOnce();
				const authorizationUrl = redirectToAuthorization.mock.calls[0][0];
				expect(authorizationUrl.searchParams.get('scope')).toBe('mcp:tools marimohub:read');
				expect(authorizationUrl.searchParams.get('resource')).toBe(`${publicBaseUrl}/mcp`);
			} finally {
				await transport.close();
			}
		},
	);

	it('keeps default Hub authorization scope selection unchanged', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			mcp: { publicBaseUrl: 'https://hub.example.com' },
		});
		deps.authenticator = { authenticate: async () => null };
		const response = await createApi(deps).request('/mcp', { method: 'POST' });
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).not.toContain('scope=');
	});

	it('exposes the initial scope challenge to browser clients', async () => {
		const deps = makeTestDeps(new MemoryBucket(), {
			mcp: {
				publicBaseUrl: 'https://hub.example.com',
				externalAuthorizationServer: 'https://issuer.example.com',
			},
		});
		deps.authenticator = { authenticate: async () => null };
		const response = await createApi(deps).request('/mcp', {
			method: 'POST',
			headers: { Origin: 'https://client.example.com' },
		});
		expect(response.status).toBe(401);
		expect(response.headers.get('access-control-expose-headers')?.toLowerCase()).toContain(
			'www-authenticate',
		);
		expect(response.headers.get('www-authenticate')).toContain('scope="mcp:tools marimohub:read"');
	});
});
