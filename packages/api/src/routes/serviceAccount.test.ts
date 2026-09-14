import { describe, expect, it } from 'vitest';
import {
	AesGcmSecretCodec,
	composeAuthenticators,
	createServices,
	defaultRegistry,
	hashPatSecret,
	OrgIntegrationsStore,
	ServiceAccountCredentials,
	UserId,
} from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createTestApi, expectError, expectOk, expectPage } from '../testing';

const token = `mhub_sa_deploy_key-1_${'a'.repeat(64)}`;
const headers = { authorization: `Bearer ${token}` };

async function setup() {
	const bucket = new MemoryBucket();
	const services = createServices(bucket);
	const machine = new ServiceAccountCredentials([
		{
			id: 'deploy',
			credentials: [{ id: 'key-1', sha256: await hashPatSecret(token) }],
			actions: ['org-integration.manage'],
		},
	]);
	const deps = {
		services,
		orgIntegrations: new OrgIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec: new AesGcmSecretCodec({ kek: '/ECMzY/eM7nlHPPNu+OM2wv0lWiFuHUScSJxNmh64N8=' }),
		}),
		authenticator: composeAuthenticators(
			services.tokens,
			{ authenticate: async () => null },
			{ serviceAccounts: machine },
		),
	};
	return { ...createTestApi({ bucket, deps }), services };
}

describe('service account API', () => {
	it('provisions org integrations on an empty bucket and preserves conditional updates', async () => {
		const { request, services } = await setup();
		expect(await expectPage(await request('GET', '/org/integrations', undefined, headers))).toEqual(
			[],
		);
		const created = await expectOk<{ id: string }>(
			await request(
				'POST',
				'/org/integrations',
				{
					kind: 'postgres',
					name: 'warehouse',
					config: { host: 'db.internal', database: 'analytics', username: 'ci', password: 'test' },
				},
				headers,
			),
			201,
		);
		const entries = await expectPage<{ id: string; name: string }>(
			await request('GET', '/org/integrations', undefined, headers),
		);
		expect(entries).toMatchObject([{ id: created.id, name: 'warehouse' }]);
		const path = `/org/integrations/${created.id}`;
		const current = await request('GET', path, undefined, headers);
		const etag = current.headers.get('ETag')!;
		await expectOk(current);
		await expectOk(
			await request('PATCH', path, { enabled: false }, { ...headers, 'If-Match': etag }),
		);
		await expectError(
			await request('PATCH', path, { enabled: true }, { ...headers, 'If-Match': etag }),
			412,
		);
		const versions = await expectPage<{ created_by: string }>(
			await request('GET', `${path}/versions`, undefined, headers),
		);
		expect(versions.length).toBeGreaterThan(0);
		const identity = await services.identities.get(UserId.parse('service-account:deploy'));
		expect(identity).toMatchObject({ name: 'deploy', email: 'deploy@service-accounts.invalid' });
		const events = await services.events.getEvents(new Date().toISOString().slice(0, 10));
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: 'integration.create', actor: 'service-account:deploy' }),
				expect.objectContaining({ event: 'integration.update', actor: 'service-account:deploy' }),
			]),
		);
		await expectOk(await request('DELETE', path, undefined, headers));
	});

	it('denies unrelated admin actions, project creation, and personal token management', async () => {
		const { request, bucket } = await setup();
		const human = createTestApi({ bucket });
		const project = await expectOk<{ id: string }>(
			await human.request('POST', '/projects', { name: 'private', description: '' }),
			201,
		);
		await expectError(await request('GET', `/projects/${project.id}`, undefined, headers), 403);
		await expectError(await request('GET', '/projects', undefined, headers), 403);
		await expectError(
			await request('POST', '/projects', { name: 'forbidden', description: '' }, headers),
			403,
		);
		await expectError(await request('GET', '/events', undefined, headers), 403);
		const error = await expectError(
			await request('POST', '/me/tokens', { name: 'forbidden' }, headers),
			403,
		);
		expect(error.message).toContain('Service accounts cannot manage tokens');
		await expectError(await request('GET', '/me/tokens', undefined, headers), 403);
		await expectError(await request('GET', '/org/integrations'), 401);
	});

	it('honors account suspension without changing configuration', async () => {
		const { request, services } = await setup();
		await expectOk(await request('GET', '/org/integrations', undefined, headers));
		const id = UserId.parse('service-account:deploy');
		await services.identities.setSuspension(id, true);
		await expectError(
			await request('GET', '/org/integrations', undefined, headers),
			403,
			'USER_SUSPENDED',
		);
		await services.identities.setSuspension(id, false);
		await expectOk(await request('GET', '/org/integrations', undefined, headers));
	});

	it('does not let a scoped PAT elevate an ordinary user to org integration management', async () => {
		const { request, services } = await setup();
		const user = UserId.parse('ordinary-user');
		await services.identities.upsert({ id: user, email: 'user@example.com' });
		const pat = await services.tokens.create(
			{ name: 'integration grant', grant: { actions: ['org-integration.manage'], projects: '*' } },
			user,
		);
		await expectError(
			await request('GET', '/org/integrations', undefined, {
				authorization: `Bearer ${pat.token}`,
			}),
			403,
		);
	});

	it('allows scoped human PATs to manage integrations without general admin access', async () => {
		const { bucket, deps, services } = await setup();
		const root = UserId.parse('human-admin');
		await services.identities.upsert({ id: root, email: 'human@example.com' });
		const pat = await services.tokens.create(
			{
				name: 'integrations-only',
				grant: { actions: ['org-integration.manage'], projects: '*' },
			},
			root,
		);
		const { request } = createTestApi({
			bucket,
			deps: { ...deps, policy: { superAdmins: [root] } },
		});
		const patHeaders = { authorization: `Bearer ${pat.token}` };
		await expectOk(await request('GET', '/org/integrations', undefined, patHeaders));
		await expectError(await request('GET', '/events', undefined, patHeaders), 403);
	});
});
