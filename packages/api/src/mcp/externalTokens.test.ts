import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerToken, composeAuthenticators, UserId, UnavailableError } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { externalTokenGrant } from '@marimo-hub/core/token-grants';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createApi } from '../createApi';
import { makeTestDeps } from '../testing';
import { createOAuthProvider } from './oauthProvider';

const publicBaseUrl = 'https://hub.example.com/hub';
const resource = `${publicBaseUrl}/mcp`;
const issuer = 'https://issuer.example.com';
const user = { id: UserId.parse('external-user'), email: 'external@example.com' };
const fullScopes = ['mcp:tools', 'marimohub:full'];
function principal(scopes: string[] = fullScopes): AuthenticatedPrincipal {
	return {
		...user,
		credential: {
			kind: 'external-access-token',
			grant: externalTokenGrant(scopes)!,
			expiresAt: new Date(Date.now() + 300000).toISOString(),
			oauth: { clientId: 'external-client', resource, scopes },
		},
	};
}
let caller: AuthenticatedPrincipal | null;
let deps: ReturnType<typeof makeTestDeps>;
let app: ReturnType<typeof createApi>;
let projectId: string;
let foreignId: string;
const headers = { Authorization: 'Bearer external', 'Content-Type': 'application/json' };
function api(path: string, method = 'GET', body?: unknown) {
	return app.request(`/api/v1${path}`, {
		method,
		headers,
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}
function mcp(method = 'tools/list', params: unknown = {}, token = 'external') {
	return app.request('/mcp', {
		method: 'POST',
		headers: {
			...headers,
			Authorization: `Bearer ${token}`,
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
}
async function toolResult(response: Response) {
	expect(response.status).toBe(200);
	const text = await response.text();
	const body = JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? text) as {
		result: { isError?: boolean; structuredContent: Record<string, unknown> };
	};
	return body.result;
}

beforeEach(async () => {
	caller = principal();
	deps = makeTestDeps(new MemoryBucket(), {
		mcp: { publicBaseUrl, externalAuthorizationServer: issuer },
	});
	await deps.services.catalog.initialize(user.id);
	await deps.services.identities.upsert(user);
	projectId = (
		await deps.services.projects.createProject({ name: 'Mine', description: '' }, user.id)
	).id;
	foreignId = (
		await deps.services.projects.createProject(
			{ name: 'Other', description: '' },
			UserId.parse('other-user'),
		)
	).id;
	deps.authenticator = composeAuthenticators(
		deps.services.tokens,
		{ authenticate: async () => null },
		{
			authenticate: async (request) => (bearerToken(request) === 'external' ? caller : null),
		},
	);
	app = createApi(deps);
});

describe('external access tokens on API and MCP', () => {
	it('advertises only the external issuer on all protected-resource metadata routes', async () => {
		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
			'/.well-known/oauth-protected-resource/hub/mcp',
		]) {
			expect(await (await app.request(path)).json()).toMatchObject({
				resource,
				authorization_servers: [issuer],
				scopes_supported: [
					'mcp:tools',
					'marimohub:read',
					'marimohub:run',
					'marimohub:edit',
					'marimohub:full',
				],
			});
		}
		caller = null;
		const response = await mcp();
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toContain(
			`resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`,
		);
	});

	it('enforces read and edit grants in API routes', async () => {
		caller = principal(['marimohub:read']);
		expect((await api(`/projects/${projectId}`)).status).toBe(200);
		const notebook = { title: 'Notebook', description: '', code: 'import marimo' };
		expect((await api(`/projects/${projectId}/notebooks`, 'POST', notebook)).status).toBe(403);
		caller = principal(['marimohub:edit']);
		expect((await api(`/projects/${projectId}/notebooks`, 'POST', notebook)).status).toBe(201);
	});

	it('does not elevate project access even with a full scope', async () => {
		expect((await api(`/projects/${foreignId}`)).status).toBe(404);
		const result = await toolResult(
			await mcp('tools/call', {
				name: 'create_notebook',
				arguments: { project: foreignId, title: 'Hidden', code: 'import marimo' },
			}),
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent.code).toBe('NOT_FOUND');
	});

	it('enforces grants in MCP tool execution', async () => {
		const params = {
			name: 'create_notebook',
			arguments: {
				project: projectId,
				title: 'MCP Notebook',
				code: 'import marimo',
				launch: false,
			},
		};
		caller = principal(['mcp:tools', 'marimohub:read']);
		const denied = await toolResult(await mcp('tools/call', params));
		expect(denied.isError).toBe(true);
		expect(denied.structuredContent.code).toBe('FORBIDDEN');
		caller = principal(['mcp:tools', 'marimohub:edit']);
		const allowed = await toolResult(await mcp('tools/call', params));
		expect(allowed.isError).not.toBe(true);
		expect(allowed.structuredContent.notebook_id).toEqual(expect.any(String));
	});

	it('requires the MCP scope and resource, and explicit external mode', async () => {
		caller = principal(['marimohub:read']);
		expect((await api('/me')).status).toBe(200);
		expect((await mcp()).status).toBe(401);
		caller = principal();
		caller.credential = {
			...caller.credential,
			oauth: { ...caller.credential.oauth!, resource: 'https://gateway.example.com' },
		};
		expect((await mcp()).status).toBe(401);
		caller = principal();
		app = createApi({ ...deps, mcp: { publicBaseUrl } });
		expect((await mcp()).status).toBe(401);
	});

	it('denies token management and session-only administration even for a super admin', async () => {
		deps.policy = { superAdmins: [user.id] };
		app = createApi(deps);
		for (const path of ['/me/tokens', '/admin/users']) {
			const response = await api(path);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				success: false,
				error: { message: expect.stringContaining('External access tokens cannot') },
			});
		}
		expect((await api('/me/tokens', 'POST', { name: 'escalation' })).status).toBe(403);
	});

	it('blocks suspended users immediately and restores access after reactivation', async () => {
		await deps.services.identities.setSuspension(user.id, true);
		expect((await api('/me')).status).toBe(403);
		expect((await mcp()).status).toBe(401);
		await deps.services.identities.setSuspension(user.id, false);
		expect((await api('/me')).status).toBe(200);
		expect((await mcp()).status).toBe(200);
	});

	it('fails closed when user suspension cannot be checked', async () => {
		vi.spyOn(deps.services.identities, 'isSuspended').mockRejectedValue(
			new UnavailableError('Unable to verify suspension'),
		);
		expect((await api('/me')).status).toBe(503);
		expect((await mcp()).status).toBe(503);
	});

	it('retains Hub OAuth tokens but does not verify external credentials as Hub-issued', async () => {
		const token = await deps.services.tokens.create(
			{
				name: 'Existing MCP',
				grant: externalTokenGrant(fullScopes)!,
				oauth: { clientId: 'hub-client', resource, scopes: ['mcp:tools'] },
			},
			user.id,
		);
		expect((await mcp('tools/list', {}, token.token)).status).toBe(200);
		const provider = createOAuthProvider(deps);
		expect(await provider.verifyAccessToken(token.token)).toMatchObject({ clientId: 'hub-client' });
		await expect(provider.verifyAccessToken('external')).rejects.toThrow(/invalid or expired/);
		expect(
			await (await app.request('/.well-known/oauth-authorization-server')).json(),
		).toMatchObject({ issuer: publicBaseUrl });
		const response = await app.request('/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ redirect_uris: ['https://client.example.com/callback'] }),
		});
		expect(response.status).toBe(201);
	});
});
