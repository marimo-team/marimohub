import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, UserId, UnavailableError } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { externalTokenGrant } from '@marimo-hub/core/token-grants';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createApi } from '../createApi';
import { makeTestDeps } from '../testing';

const publicBaseUrl = 'https://hub.example.com/hub';
const scopes = ['mcp:tools', 'marimohub:read'];
const user: AuthenticatedPrincipal = {
	id: UserId.parse('mcp-first-user'),
	email: 'mcp-first@example.com',
	name: 'MCP First User',
	credential: {
		kind: 'external-access-token',
		grant: externalTokenGrant(scopes)!,
		expiresAt: new Date(Date.now() + 300000).toISOString(),
		oauth: { clientId: 'client', resource: `${publicBaseUrl}/mcp`, scopes },
	},
};
let caller: AuthenticatedPrincipal | null;
let bucket: MemoryBucket;
let deps: ReturnType<typeof makeTestDeps>;
let app: ReturnType<typeof createApi>;

function listCatalog() {
	return app.request('/mcp', {
		method: 'POST',
		headers: {
			Authorization: 'Bearer external',
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'list_catalog', arguments: {} },
		}),
	});
}
async function expectDefaultProject(response: Response) {
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? text)).toMatchObject({
		result: { structuredContent: { projects: [{ name: 'My Projects', notebooks: [] }] } },
	});
}

beforeEach(() => {
	caller = user;
	bucket = new MemoryBucket();
	deps = makeTestDeps(bucket, {
		mcp: { publicBaseUrl, externalAuthorizationServer: 'https://issuer.example.com' },
		authenticator: { authenticate: async () => caller },
	});
	app = createApi(deps);
});
afterEach(() => vi.restoreAllMocks());

describe('MCP as the first Hub interaction', () => {
	it('initializes the catalog and records a user who can then be suspended', async () => {
		expect(await bucket.head(paths.catalog)).toBeNull();
		expect(await deps.services.identities.list()).toEqual([]);

		await expectDefaultProject(await listCatalog());
		const snapshot = await deps.services.catalog.getCurrentSnapshot();
		expect(snapshot.projects).toHaveLength(1);
		expect(await deps.services.identities.list()).toMatchObject([
			{ id: user.id, email: user.email, name: user.name },
		]);

		await expectDefaultProject(await listCatalog());
		expect((await deps.services.catalog.getCurrentSnapshot()).projects).toEqual(snapshot.projects);
		await deps.services.identities.setSuspension(user.id, true);
		expect((await listCatalog()).status).toBe(401);
		await deps.services.identities.setSuspension(user.id, false);
		await expectDefaultProject(await listCatalog());
	});

	it('does not initialize storage or record a user during discovery', async () => {
		const upsert = vi.spyOn(deps.services.identities, 'upsert');
		expect((await app.request('/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
		expect(await bucket.head(paths.catalog)).toBeNull();
		expect(upsert).not.toHaveBeenCalled();
	});

	it.each(['invalid-token', 'wrong-resource', 'missing-scope', 'sso', 'disabled'])(
		'does not initialize storage or record a rejected principal: %s',
		async (failure) => {
			if (failure === 'invalid-token') caller = null;
			if (failure === 'sso') caller = { ...user, credential: { kind: 'sso' } };
			if (failure === 'disabled') app = createApi({ ...deps, mcp: { publicBaseUrl } });
			if (failure === 'wrong-resource' || failure === 'missing-scope') {
				caller = {
					...user,
					credential: {
						...user.credential,
						oauth: {
							...user.credential.oauth!,
							...(failure === 'wrong-resource'
								? { resource: 'https://other.example.com/mcp' }
								: { scopes: ['marimohub:read'] }),
						},
					},
				};
			}
			const upsert = vi.spyOn(deps.services.identities, 'upsert');
			expect((await listCatalog()).status).toBe(401);
			expect(upsert).not.toHaveBeenCalled();
			expect(await bucket.head(paths.catalog)).toBeNull();
			expect(await deps.services.identities.get(user.id)).toBeNull();
		},
	);

	it('does not refresh a suspended identity or initialize its catalog', async () => {
		await deps.services.identities.upsert(user);
		await deps.services.identities.setSuspension(user.id, true);
		const upsert = vi.spyOn(deps.services.identities, 'upsert');
		expect((await listCatalog()).status).toBe(401);
		expect(upsert).not.toHaveBeenCalled();
		expect(await bucket.head(paths.catalog)).toBeNull();
		expect((await deps.services.identities.get(user.id))?.suspended_at).toBeDefined();
	});

	it('serves the tool call despite a directory failure and retries on the next request', async () => {
		const upsert = vi
			.spyOn(deps.services.identities, 'upsert')
			.mockRejectedValueOnce(new Error('private-identity-details'));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await expectDefaultProject(await listCatalog());
		expect(await deps.services.identities.get(user.id)).toBeNull();
		const logs = JSON.stringify(log.mock.calls);
		expect(logs).toContain('identity_upsert_failed');
		expect(logs).not.toContain('private-identity-details');
		await expectDefaultProject(await listCatalog());
		expect(await deps.services.identities.get(user.id)).toMatchObject({ id: user.id });
		expect(upsert).toHaveBeenCalledTimes(2);
	});

	it('fails closed on initialization failure and recovers on the next request', async () => {
		vi.spyOn(bucket, 'head').mockRejectedValueOnce(new UnavailableError('Storage unavailable'));
		expect((await listCatalog()).status).toBe(503);
		expect(await bucket.head(paths.catalog)).toBeNull();
		await expectDefaultProject(await listCatalog());
	});
});
