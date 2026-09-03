import { describe, expect, it } from 'vitest';
import { makeFakeCompute, MemoryBucket } from '@marimo-hub/core/testing';
import { bearerToken, expandTokenGrantPreset, UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { createApi } from '../createApi';
import { makeTestDeps } from '../testing';

const USER: AuthenticatedPrincipal = {
	id: UserId.parse('oauth-user'),
	email: 'oauth@example.com',
	name: 'OAuth User',
	credential: { kind: 'development' },
};

async function challenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

async function mcpJson(response: Response): Promise<unknown> {
	const text = await response.text();
	const data = /^data: (.+)$/m.exec(text)?.[1] ?? text;
	return JSON.parse(data);
}

describe('MCP OAuth app', () => {
	it('discovers OAuth and exchanges browser consent for a PAT', async () => {
		const compute = makeFakeCompute();
		compute.proxy = async (request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith('/api/sessions')) {
				return new Response(JSON.stringify([{ id: 'kernel-one', path: '/notebook.py' }]), {
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (path.endsWith('/api/kernel/execute')) {
				return new Response(
					'event: stdout\ndata: {"data":"2\\n"}\n\n' +
						'event: done\ndata: {"success":true,"output":{"mimetype":"text/plain","data":"2"}}\n\n',
					{ headers: { 'Content-Type': 'text/event-stream' } },
				);
			}
			return null;
		};
		const deps = makeTestDeps(new MemoryBucket(), {
			mcp: { publicBaseUrl: 'https://hub.example.com' },
			compute,
		});
		deps.authenticator = {
			authenticate: async (request) => {
				const token = bearerToken(request);
				return token ? deps.services.tokens.verify(token) : USER;
			},
		};
		const app = createApi(deps);
		const projectPage = (await (await app.request('/api/v1/projects')).json()) as {
			data: { items: { id: string }[] };
		};
		const projectId = projectPage.data.items[0].id;
		const notebookCreated = await app.request(`/api/v1/projects/${projectId}/notebooks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'MCP notebook',
				description: '',
				code: 'import marimo as mo',
			}),
		});
		expect(notebookCreated.status).toBe(201);

		const unauthorized = await app.request('/mcp', { method: 'POST' });
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get('www-authenticate')).toContain(
			'resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource/mcp"',
		);

		const resource = await app.request('/.well-known/oauth-protected-resource/mcp');
		expect(resource.status).toBe(200);
		expect(await resource.json()).toMatchObject({
			resource: 'https://hub.example.com/mcp',
			authorization_servers: ['https://hub.example.com'],
		});
		expect((await app.request('/.well-known/oauth-protected-resource')).status).toBe(200);
		const authorizationServer = await app.request('/.well-known/oauth-authorization-server');
		expect(authorizationServer.status).toBe(200);
		expect(await authorizationServer.json()).toMatchObject({
			issuer: 'https://hub.example.com',
			token_endpoint_auth_methods_supported: ['none'],
			grant_types_supported: ['authorization_code'],
			code_challenge_methods_supported: ['S256'],
		});

		const registered = await app.request('/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'T'.repeat(200),
				redirect_uris: ['https://client.example/callback'],
				token_endpoint_auth_method: 'none',
			}),
		});
		expect(registered.status).toBe(201);
		const client = (await registered.json()) as { client_id: string };

		const verifier = 'v'.repeat(43);
		const authorizeUrl = new URL('https://hub.example.com/authorize');
		authorizeUrl.search = new URLSearchParams({
			client_id: client.client_id,
			response_type: 'code',
			redirect_uri: 'https://client.example/callback',
			code_challenge: await challenge(verifier),
			code_challenge_method: 'S256',
			state: 'test-state',
			resource: 'https://hub.example.com/mcp',
		}).toString();
		const authorization = await app.request(authorizeUrl, { redirect: 'manual' });
		expect(authorization.status).toBe(302);
		const consent = new URL(authorization.headers.get('location')!);
		expect(consent.pathname).toBe('/oauth/consent');
		const id = consent.searchParams.get('id')!;

		const preview = await app.request(`/api/v1/me/oauth-authorizations/${id}`);
		expect(preview.status).toBe(200);
		const approved = await app.request(`/api/v1/me/oauth-authorizations/${id}/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				grant: { actions: expandTokenGrantPreset('edit'), projects: '*' },
				expires_in_days: 7,
			}),
		});
		expect(approved.status).toBe(200);
		const approvalBody = (await approved.json()) as {
			data: { redirect_uri: string };
		};
		const code = new URL(approvalBody.data.redirect_uri).searchParams.get('code')!;

		const exchanged = await app.request('/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: client.client_id,
				code,
				code_verifier: verifier,
				redirect_uri: 'https://client.example/callback',
				resource: 'https://hub.example.com/mcp',
			}),
		});
		expect(exchanged.status).toBe(200);
		const tokens = (await exchanged.json()) as { access_token: string; token_type: string };
		expect(tokens.access_token).toMatch(/^mhub_pat_/);
		expect(tokens.token_type).toBe('bearer');
		expect(await deps.services.tokens.verify(tokens.access_token)).toMatchObject({ id: USER.id });
		expect(await deps.services.tokens.list(USER.id)).toContainEqual(
			expect.objectContaining({ name: `MCP · ${'T'.repeat(94)}` }),
		);

		const mcpHeaders = {
			Authorization: `Bearer ${tokens.access_token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		};
		const initialized = await app.request('/mcp', {
			method: 'POST',
			headers: mcpHeaders,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'test', version: '1' },
				},
			}),
		});
		expect(initialized.status).toBe(200);

		const tools = await app.request('/mcp', {
			method: 'POST',
			headers: mcpHeaders,
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
		});
		expect(tools.status).toBe(200);
		const toolList = (await mcpJson(tools)) as { result: { tools: { name: string }[] } };
		expect(toolList.result.tools.map((tool) => tool.name)).toEqual([
			'list_catalog',
			'launch_notebook',
			'execute_code',
		]);

		const catalog = await app.request('/mcp', {
			method: 'POST',
			headers: mcpHeaders,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'list_catalog', arguments: {} },
			}),
		});
		expect(catalog.status).toBe(200);
		expect(await mcpJson(catalog)).toMatchObject({
			result: {
				structuredContent: {
					projects: [{ name: 'My Projects', notebooks: [{ title: 'MCP notebook' }] }],
				},
			},
		});

		const launched = await app.request('/mcp', {
			method: 'POST',
			headers: mcpHeaders,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: {
					name: 'launch_notebook',
					arguments: {
						project: 'My Projects',
						notebook: 'MCP notebook',
						wait_seconds: 0,
					},
				},
			}),
		});
		expect(launched.status).toBe(200);
		const launchResult = (await mcpJson(launched)) as {
			result: { structuredContent: { session_id: string; status: string } };
		};
		expect(launchResult.result.structuredContent.status).toBe('running');

		const executed = await app.request('/mcp', {
			method: 'POST',
			headers: mcpHeaders,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: {
					name: 'execute_code',
					arguments: {
						project: 'My Projects',
						session_id: launchResult.result.structuredContent.session_id,
						code: '1+1',
					},
				},
			}),
		});
		expect(executed.status).toBe(200);
		expect(await mcpJson(executed)).toMatchObject({
			result: {
				structuredContent: {
					completed: true,
					success: true,
					stdout: '2\n',
					output: { mimetype: 'text/plain', data: '2' },
				},
			},
		});

		const revoked = await app.request('/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: client.client_id,
				token: tokens.access_token,
				token_type_hint: 'access_token',
			}),
		});
		expect(revoked.status).toBe(200);
		expect(
			(
				await app.request('/mcp', {
					method: 'POST',
					headers: mcpHeaders,
				})
			).status,
		).toBe(401);
	});

	it('keeps discovery URLs under a configured public path prefix', async () => {
		const app = createApi(
			makeTestDeps(new MemoryBucket(), {
				mcp: { publicBaseUrl: 'https://hub.example.com/marimohub' },
			}),
		);
		const authorizationServer = await app.request('/.well-known/oauth-authorization-server');
		expect(await authorizationServer.json()).toMatchObject({
			issuer: 'https://hub.example.com/marimohub',
			authorization_endpoint: 'https://hub.example.com/marimohub/authorize',
			token_endpoint: 'https://hub.example.com/marimohub/token',
			registration_endpoint: 'https://hub.example.com/marimohub/register',
			revocation_endpoint: 'https://hub.example.com/marimohub/revoke',
		});
		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
		]) {
			expect(await (await app.request(path)).json()).toMatchObject({
				resource: 'https://hub.example.com/marimohub/mcp',
				authorization_servers: ['https://hub.example.com/marimohub'],
			});
		}
		const unauthorized = await app.request('/mcp', { method: 'POST' });
		expect(unauthorized.headers.get('www-authenticate')).toContain(
			'resource_metadata="https://hub.example.com/marimohub/.well-known/oauth-protected-resource/mcp"',
		);
	});

	it('rate limits authorization requests before they create unbounded records', async () => {
		const bucket = new MemoryBucket();
		const app = createApi(
			makeTestDeps(bucket, { mcp: { publicBaseUrl: 'https://limited.example.com' } }),
		);
		const registered = await app.request('/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				redirect_uris: ['https://client.example/callback'],
				token_endpoint_auth_method: 'none',
			}),
		});
		const client = (await registered.json()) as { client_id: string };
		const authorizeUrl = new URL('https://limited.example.com/authorize');
		authorizeUrl.search = new URLSearchParams({
			client_id: client.client_id,
			response_type: 'code',
			redirect_uri: 'https://client.example/callback',
			code_challenge: await challenge('r'.repeat(43)),
			code_challenge_method: 'S256',
			resource: 'https://limited.example.com/mcp',
		}).toString();

		const statuses: number[] = [];
		for (let index = 0; index < 105; index += 1) {
			statuses.push((await app.request(authorizeUrl, { redirect: 'manual' })).status);
		}
		expect(statuses).toContain(429);
		const authorizations = await bucket.list({ prefix: '_system/oauth-authorizations/' });
		expect(authorizations.objects.length).toBeLessThanOrEqual(100);
	});

	it('returns 404s while MCP is disabled', async () => {
		const app = createApi(makeTestDeps(new MemoryBucket(), { mcp: undefined }));
		expect((await app.request('/mcp', { method: 'POST' })).status).toBe(404);
		expect((await app.request('/.well-known/oauth-protected-resource/mcp')).status).toBe(404);
	});
});
