import { describe, expect, it, vi } from 'vitest';
import { AesGcmSecretCodec, defaultRegistry, ProjectIntegrationsStore } from '@marimo-hub/core';
import type { IntegrationReconciliationPlan } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';

const desired = {
	name: 'warehouse',
	kind: 'postgres',
	config: {
		host: 'db.internal',
		database: 'analytics',
		username: 'reader',
		password: 'private-value',
	},
};
async function setup() {
	const bucket = await createInitializedBucket();
	const integrations = new ProjectIntegrationsStore({
		bucket,
		registry: defaultRegistry(),
		codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
	});
	const { request } = createTestApi({ bucket, userId: ACTOR, deps: { integrations } });
	const project = await expectOk<{ id: string }>(
		await request('POST', '/projects', { name: 'P', description: '' }),
		201,
	);
	return {
		bucket,
		integrations,
		request,
		pid: project.id,
		path: `/projects/${project.id}/integrations/reconcile/`,
	};
}

describe('integration reconciliation routes', () => {
	it('previews, applies and rejects stale state using safe envelopes', async () => {
		const { request, path, pid } = await setup();
		const plan = await expectOk<IntegrationReconciliationPlan>(
			await request('POST', `${path}plan`, desired),
		);
		expect(plan.action).toBe('create');
		expect(JSON.stringify(plan)).not.toContain('private-value');
		const result = await expectOk(
			await request('POST', `${path}apply`, { desired, expected: plan.precondition }),
		);
		expect(result).toMatchObject({ action: 'created', current_version: 1 });
		expect(
			(await request('POST', `${path}apply`, { desired, expected: plan.precondition })).status,
		).toBe(412);
		const next = await expectOk<IntegrationReconciliationPlan>(
			await request('POST', `${path}plan`, desired),
		);
		expect(next.action).toBe('unchanged');
		expect(
			await expectOk(
				await request('POST', `${path}apply`, { desired, expected: next.precondition }),
			),
		).toMatchObject({ action: 'unchanged' });
		const events = await expectOk<{ event: string }[]>(
			await request('GET', `/projects/${pid}/events`),
		);
		expect(events.filter((event) => event.event === 'integration.create')).toHaveLength(1);
		expect(events.filter((event) => event.event === 'integration.update')).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain('private-value');
	});
	it('requires a precondition and validates mode before calling the store', async () => {
		const { request, path, integrations } = await setup();
		const apply = vi.spyOn(integrations, 'applyReconciliation');
		expect((await request('POST', `${path}apply`, { desired })).status).toBe(422);
		expect((await request('POST', `${path}plan`, { ...desired, mode: 'delete' })).status).toBe(422);
		expect(apply).not.toHaveBeenCalled();
	});
	it('does not invoke comparison for unauthorized users', async () => {
		const { bucket, integrations, path } = await setup();
		const plan = vi.spyOn(integrations, 'planReconciliation');
		const apply = vi.spyOn(integrations, 'applyReconciliation');
		const outsider = createTestApi({
			bucket,
			userId: uid('outsider'),
			deps: { integrations },
		}).request;
		expect((await outsider('POST', `${path}plan`, desired)).status).toBe(403);
		expect(
			(await outsider('POST', `${path}apply`, { desired, expected: { state: 'absent' } })).status,
		).toBe(403);
		expect(plan).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});
	it('denies read-only PATs and organization service accounts before comparison', async () => {
		const { bucket, integrations, path } = await setup();
		const plan = vi.spyOn(integrations, 'planReconciliation');
		const apply = vi.spyOn(integrations, 'applyReconciliation');
		for (const credential of [
			{
				kind: 'personal-access-token' as const,
				grant: {
					actions: ['project.read' as const, 'integration.read' as const],
					projects: '*' as const,
				},
			},
			{
				kind: 'service-account' as const,
				grant: { actions: ['org-integration.manage' as const], projects: '*' as const },
			},
		]) {
			const restricted = createTestApi({
				bucket,
				userId: ACTOR,
				subject: { credential },
				deps: { integrations },
			}).request;
			expect((await restricted('POST', `${path}plan`, desired)).status).toBe(
				credential.kind === 'service-account' ? 404 : 403,
			);
			expect(
				(await restricted('POST', `${path}apply`, { desired, expected: { state: 'absent' } }))
					.status,
			).toBe(credential.kind === 'service-account' ? 404 : 403);
		}
		expect(plan).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});
});

it.each([
	{ state: 'existing' },
	{ state: 'existing', id: 'invalid', revision: 123 },
	{ state: 'unknown' },
	null,
])('rejects malformed precondition %# before reaching the store', async (expected) => {
	const { request, path, integrations } = await setup();
	const apply = vi.spyOn(integrations, 'applyReconciliation');
	expect((await request('POST', `${path}apply`, { desired, expected })).status).toBe(422);
	expect(apply).not.toHaveBeenCalled();
});
it('rejects a stale existing revision without writing or auditing an update', async () => {
	const { request, path, pid, integrations } = await setup();
	const plan = await expectOk<IntegrationReconciliationPlan>(
		await request('POST', `${path}plan`, desired),
	);
	await expectOk(await request('POST', `${path}apply`, { desired, expected: plan.precondition }));
	const stale = await expectOk<IntegrationReconciliationPlan>(
		await request('POST', `${path}plan`, desired),
	);
	const changed = { ...desired, enabled: false };
	await expectOk(
		await request('POST', `${path}apply`, { desired: changed, expected: stale.precondition }),
	);
	const update = vi.spyOn(integrations, 'update');
	expect(
		(await request('POST', `${path}apply`, { desired, expected: stale.precondition })).status,
	).toBe(412);
	expect(update).not.toHaveBeenCalled();
	const events = await expectOk<{ event: string }[]>(
		await request('GET', `/projects/${pid}/events`),
	);
	expect(events.filter((event) => event.event === 'integration.update')).toHaveLength(1);
});
