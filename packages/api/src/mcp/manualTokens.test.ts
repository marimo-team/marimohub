import { describe, expect, it, vi, afterEach } from 'vitest';
import { composeAuthenticators, paths, TokenService, UnavailableError } from '@marimo-hub/core';
import type { TokenGrant } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createApi } from '../createApi';
import { createTestApi, expectError, expectOk } from '../testing';
import { postMcp, readMcpResult } from '../testing/mcp';
import { createOAuthProvider } from './oauthProvider';

const publicBaseUrl = 'https://hub.example.com/hub';
const resource = `${publicBaseUrl}/mcp`;
const grant: TokenGrant = { actions: ['project.read'], projects: '*' };
const body = { name: 'header-client', expires_in_days: 30, grant };
interface Created {
	id: string;
	token: string;
	mcp_resource: string;
	grant: TokenGrant;
	expires_at?: string;
}

function setup(manualTokens?: boolean) {
	const api = createTestApi({ deps: { mcp: { publicBaseUrl, manualTokens } } });
	const sessionAuthenticate = api.deps.authenticator.authenticate;
	api.deps.authenticator.authenticate = composeAuthenticators(api.deps.services.tokens, {
		authenticate: sessionAuthenticate,
	}).authenticate;
	return api;
}

function mcpRequest(app: ReturnType<typeof createApi>, token: string, params?: unknown) {
	return postMcp(app, params ? { method: 'tools/call', params } : { method: 'tools/list' }, {
		Authorization: `Bearer ${token}`,
	});
}
async function mcpResult(response: Response) {
	expect(response.status).toBe(200);
	return readMcpResult<{
		tools?: unknown[];
		structuredContent?: { projects: unknown[] };
		isError?: boolean;
	}>(response);
}

afterEach(() => vi.restoreAllMocks());

describe('manual MCP tokens', () => {
	it.each([undefined, false])(
		'disables creation and authentication when the flag is %s',
		async (enabled) => {
			const { app, request, deps } = setup(enabled);
			await expectError(await request('POST', '/me/tokens/mcp', body), 404, 'NOT_FOUND');
			const minted = await deps.services.tokens.create(
				{ name: 'manual', grant, mcpResource: resource },
				ACTOR,
			);
			expect((await mcpRequest(app, minted.token)).status).toBe(401);
			const capabilities = await expectOk(await request('GET', '/capabilities'));
			expect(capabilities.mcp.manual_tokens).toBe(false);
		},
	);

	it('requires MCP itself to be enabled', async () => {
		const { request } = createTestApi();
		await expectError(await request('POST', '/me/tokens/mcp', body), 404, 'NOT_FOUND');
	});

	it('creates a resource-bound token, lists metadata, and authenticates with only a header', async () => {
		const { app, request, deps } = setup(true);
		const created = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		expect(created).toMatchObject({ mcp_resource: resource, grant });
		expect(created.token).toMatch(/^mhub_pat_/);
		const listed = await expectOk(await request('GET', '/me/tokens'));
		expect(listed).toEqual([expect.objectContaining({ id: created.id, mcp_resource: resource })]);
		expect(listed[0]).not.toHaveProperty('token');
		expect(listed[0]).not.toHaveProperty('hash');
		const result = await mcpResult(await mcpRequest(app, created.token));
		expect(result.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'list_catalog' })]),
		);
		expect((await expectOk(await request('GET', '/capabilities'))).mcp.manual_tokens).toBe(true);
		await expect(createOAuthProvider(deps).verifyAccessToken(created.token)).rejects.toThrow(
			/invalid or expired/,
		);
	});

	it('requires session authentication to mint tokens', async () => {
		const { request } = setup(true);
		const scoped = await expectOk<Created>(await request('POST', '/me/tokens/scoped', body), 201);
		await expectError(
			await request('POST', '/me/tokens/mcp', body, { Authorization: `Bearer ${scoped.token}` }),
			403,
		);
	});

	it('restricts manual tokens to MCP', async () => {
		const { app, request, deps } = setup(true);
		const created = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		const rest = (api: ReturnType<typeof createApi>) =>
			api.request('/api/v1/projects', { headers: { Authorization: `Bearer ${created.token}` } });
		await expectError(await rest(app), 401, 'UNAUTHORIZED');
		await expectError(
			await request('POST', '/me/tokens/mcp', body, { Authorization: `Bearer ${created.token}` }),
			401,
			'UNAUTHORIZED',
		);
		expect((await mcpRequest(app, created.token)).status).toBe(200);
		const disabled = createApi({ ...deps, mcp: { publicBaseUrl, manualTokens: false } });
		expect((await mcpRequest(disabled, created.token)).status).toBe(401);
		await expectError(await rest(disabled), 401, 'UNAUTHORIZED');
	});

	it('rejects manual tokens on the authenticated deep health check', async () => {
		const { app, request } = setup(true);
		const created = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		await expectError(
			await app.request('/api/health?deep=true', {
				headers: { Authorization: `Bearer ${created.token}` },
			}),
			401,
			'UNAUTHORIZED',
		);
	});

	it.each([
		{ ...body, mcp_resource: 'https://other.example/mcp' },
		{ ...body, oauth: { clientId: 'forged' } },
		{ name: 'permanent', grant },
		{ ...body, expires_in_days: 91 },
	])('rejects caller-supplied bindings and unbounded lifetimes: %j', async (input) => {
		const { request, deps } = setup(true);
		await expectError(await request('POST', '/me/tokens/mcp', input), 422);
		expect(await deps.services.tokens.list(ACTOR)).toEqual([]);
	});

	it('keeps ordinary API tokens rejected with manual tokens enabled', async () => {
		const { app, request } = setup(true);
		for (const [path, input] of [
			['/me/tokens', { name: 'legacy' }],
			['/me/tokens/scoped', body],
		] as const) {
			const created = await expectOk<Created>(await request('POST', path, input), 201);
			expect((await mcpRequest(app, created.token)).status).toBe(401);
		}
	});

	it('enforces the current flag, resource, expiry, suspension, and revocation', async () => {
		const { app, request, deps } = setup(true);
		const created = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		expect((await mcpRequest(app, created.token)).status).toBe(200);
		for (const mcp of [
			{ publicBaseUrl, manualTokens: false },
			{ publicBaseUrl: 'https://other.example', manualTokens: true },
		]) {
			expect((await mcpRequest(createApi({ ...deps, mcp }), created.token)).status).toBe(401);
		}
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 86400000);
		expect((await mcpRequest(app, created.token)).status).toBe(401);
		vi.restoreAllMocks();
		await deps.services.identities.setSuspension(ACTOR, true);
		expect((await mcpRequest(app, created.token)).status).toBe(401);
		await deps.services.identities.setSuspension(ACTOR, false);
		expect((await mcpRequest(app, created.token)).status).toBe(200);
		await expectOk(await request('DELETE', `/me/tokens/${created.id}`));
		expect((await mcpRequest(app, created.token)).status).toBe(401);
		expect(await deps.services.tokens.verify(created.token)).toBeNull();
	});

	it('preserves action and selected-project grants on MCP tool calls', async () => {
		const { app, request, bucket } = setup(true);
		const a = await expectOk(
			await request('POST', '/projects', { name: 'Allowed', description: '' }),
			201,
		);
		await expectOk(await request('POST', '/projects', { name: 'Excluded', description: '' }), 201);
		const scopedGrant = { actions: ['project.read'], projects: [a.id] };
		const created = await expectOk<Created>(
			await request('POST', '/me/tokens/mcp', { ...body, grant: scopedGrant }),
			201,
		);
		const catalog = await mcpResult(
			await mcpRequest(app, created.token, { name: 'list_catalog', arguments: {} }),
		);
		expect(catalog.structuredContent?.projects).toEqual([
			expect.objectContaining({ name: 'Allowed' }),
		]);
		const denied = await mcpResult(
			await mcpRequest(app, created.token, {
				name: 'create_notebook',
				arguments: { project: a.id, title: 'Denied', code: 'import marimo' },
			}),
		);
		expect(denied.isError).toBe(true);
		expect(JSON.stringify(denied)).toMatch(
			/forbidden|not granted|not permitted|denied|does not allow/i,
		);
		const other = createTestApi({ bucket, userId: uid('other-user') });
		const hidden = await expectOk(
			await other.request('POST', '/projects', { name: 'Hidden', description: '' }),
			201,
		);
		await expectError(
			await request('POST', '/me/tokens/mcp', {
				...body,
				grant: { actions: '*', projects: [hidden.id] },
			}),
			404,
		);
	});
	it('rejects unauthenticated creation without issuing a token', async () => {
		const { request, deps } = setup(true);
		deps.authenticator.authenticate = async () => null;
		await expectError(await request('POST', '/me/tokens/mcp', body), 401, 'UNAUTHORIZED');
		expect(await deps.services.tokens.list(ACTOR)).toEqual([]);
	});

	it('does not fall back to a browser session for malformed or tampered bearer credentials', async () => {
		const { app, request } = setup(true);
		const created = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		const last = created.token.at(-1);
		const tampered = created.token.slice(0, -1) + (last === 'a' ? 'b' : 'a');
		for (const authorization of [
			'Bearer',
			'Bearer invalid',
			`Bearer ${tampered}`,
			`Bearer ${created.token}, Bearer ${created.token}`,
			`Bearer ${created.token} extra`,
		]) {
			await expectError(
				await request('POST', '/me/tokens/mcp', body, { Authorization: authorization }),
				401,
			);
			expect(
				(await app.request('/mcp', { method: 'POST', headers: { Authorization: authorization } }))
					.status,
			).toBe(401);
		}
		for (const scheme of ['bearer', 'BEARER']) {
			await expectError(
				await request('POST', '/me/tokens/mcp', body, {
					Authorization: `${scheme} ${created.token}`,
				}),
				401,
			);
		}
		for (const path of ['/mcp', `/mcp?access_token=${created.token}`]) {
			expect((await app.request(path, { method: 'POST' })).status).toBe(401);
		}
	});

	it('returns a storage failure without a success response or token creation audit', async () => {
		const { request, deps, bucket } = setup(true);
		await request('GET', '/me');
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, data, options) => {
			if (key.startsWith(paths.tokensPrefix))
				throw new UnavailableError('Token storage unavailable');
			return put(key, data, options);
		});
		await expectError(await request('POST', '/me/tokens/mcp', body), 503, 'SERVICE_UNAVAILABLE');
		expect(await deps.services.tokens.list(ACTOR)).toEqual([]);
		const events = await deps.services.events.getEvents(new Date().toISOString().slice(0, 10));
		expect(events.filter((event) => event.event === 'token.create')).toEqual([]);
	});

	it('shares the token limit with API tokens and allows creation after revocation', async () => {
		const { request, deps } = setup(true);
		await request('GET', '/me');
		for (let i = 0; i < TokenService.MAX_TOKENS_PER_USER; i++) {
			await deps.services.tokens.create({ name: `api-${i}`, grant }, ACTOR);
		}
		await expectError(await request('POST', '/me/tokens/mcp', body), 429, 'RESOURCE_EXHAUSTED');
		const tokens = await deps.services.tokens.list(ACTOR);
		expect(tokens).toHaveLength(TokenService.MAX_TOKENS_PER_USER);
		await expectOk(await request('DELETE', `/me/tokens/${tokens[0].id}`));
		await expectOk(await request('POST', '/me/tokens/mcp', body), 201);
	});

	it('audits the grant and resource without recording the secret', async () => {
		const { request, deps } = setup(true);
		const created = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		const events = await deps.services.events.getEvents(new Date().toISOString().slice(0, 10));
		expect(events.find((event) => event.event === 'token.create')).toMatchObject({
			actor: ACTOR,
			token_id: created.id,
			source: 'mcp-manual',
			mcp_resource: resource,
			grant,
		});
		expect(JSON.stringify(events)).not.toContain(created.token);
		expect(JSON.stringify(events)).not.toContain(created.token.split('_').at(-1));
	});

	it('rejects a cached token at the exact expiry', async () => {
		const { app, request } = setup(true);
		const created = await expectOk<Created>(
			await request('POST', '/me/tokens/mcp', { ...body, expires_in_days: 1 }),
			201,
		);
		const longest = await expectOk<Created>(
			await request('POST', '/me/tokens/mcp', { ...body, expires_in_days: 90 }),
			201,
		);
		const expiry = Date.parse(created.expires_at!);
		const now = vi.spyOn(Date, 'now').mockReturnValue(expiry - 1);
		expect((await mcpRequest(app, created.token)).status).toBe(200);
		now.mockReturnValue(expiry);
		expect((await mcpRequest(app, created.token)).status).toBe(401);
		expect((await mcpRequest(app, longest.token)).status).toBe(200);
	});

	it('keeps OAuth working when manual tokens are disabled and restores only unrevoked manual tokens', async () => {
		const { app, request, deps } = setup(true);
		const manual = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		const revoked = await expectOk<Created>(await request('POST', '/me/tokens/mcp', body), 201);
		const oauth = await deps.services.tokens.create(
			{ name: 'oauth', grant, oauth: { clientId: 'client', resource, scopes: ['mcp:tools'] } },
			ACTOR,
		);
		const disabled = createApi({ ...deps, mcp: { publicBaseUrl, manualTokens: false } });
		expect((await mcpRequest(disabled, manual.token)).status).toBe(401);
		expect((await mcpRequest(disabled, oauth.token)).status).toBe(200);
		await expectOk(await request('DELETE', `/me/tokens/${revoked.id}`));
		expect((await mcpRequest(app, manual.token)).status).toBe(200);
		expect((await mcpRequest(app, revoked.token)).status).toBe(401);
	});

	it('removes access when project membership is removed after issuance', async () => {
		const { app, request, bucket } = setup(true);
		const owner = createTestApi({ bucket, userId: uid('project-owner') });
		const project = await expectOk<{ id: string }>(
			await owner.request('POST', '/projects', { name: 'Shared', description: '' }),
			201,
		);
		await request('GET', '/me');
		await expectOk(
			await owner.request('POST', `/projects/${project.id}/members`, {
				user_id: ACTOR,
				role: 'viewer',
			}),
			201,
		);
		const created = await expectOk<Created>(
			await request('POST', '/me/tokens/mcp', {
				...body,
				grant: { ...grant, projects: [project.id] },
			}),
			201,
		);
		const catalog = async () =>
			mcpResult(await mcpRequest(app, created.token, { name: 'list_catalog', arguments: {} }));
		expect((await catalog()).structuredContent?.projects).toEqual([
			expect.objectContaining({ name: 'Shared' }),
		]);
		await expectOk(await owner.request('DELETE', `/projects/${project.id}/members/${ACTOR}`));
		expect((await catalog()).structuredContent?.projects).toEqual([]);
	});
});
