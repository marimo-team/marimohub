import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProjectId } from '../../ids';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '../../testing';
import { AesGcmSecretCodec } from '../secrets/AesGcmSecretCodec';
import { defaultRegistry } from './kinds';
import { ProjectIntegrationsStore, OrgIntegrationsStore } from './ProjectIntegrationsStore';
import { IntegrationRegistry } from './registry';
import { changedConfigPaths } from './reconciliation';
import { defineIntegration } from './sdk';
import { zSecret } from './secretFields';
import type { ReconcileIntegrationInput } from '../../ports/integrations';

const codec = new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' });
const desired: ReconcileIntegrationInput = {
	name: 'warehouse',
	kind: 'postgres',
	config: {
		host: 'db.internal',
		database: 'analytics',
		username: 'reader',
		password: 'sensitive-value',
	},
};
function setup() {
	const bucket = new MemoryBucket();
	const resolve = vi.fn(async () => 'external');
	const options = {
		bucket,
		registry: defaultRegistry(),
		codec,
		resolvers: [
			{ backend: 'vault', title: 'Vault', locatorPlaceholder: '', locatorHelp: '', resolve },
		],
	};
	const store = new ProjectIntegrationsStore(options);
	return { bucket, resolve, store, org: new OrgIntegrationsStore(options), pid: createProjectId() };
}
async function apply(
	store: ProjectIntegrationsStore,
	pid: ReturnType<typeof createProjectId>,
	input = desired,
) {
	const plan = await store.planReconciliation(pid, input);
	return store.applyReconciliation(pid, input, plan.precondition, ACTOR);
}

describe('integration reconciliation', () => {
	it('previews without writes and repeats inline-secret upserts without mutation', async () => {
		const { bucket, store, pid } = setup();
		const put = vi.spyOn(bucket, 'put');
		const initial = await store.planReconciliation(pid, desired);
		expect(initial.action).toBe('create');
		expect(put).not.toHaveBeenCalled();
		const created = await apply(store, pid);
		const before = await store.get(pid, created.id);
		put.mockClear();
		const same = await apply(store, pid, {
			...desired,
			config: { ...desired.config, port: 5432, ssl: { mode: 'verify-full' } },
		});
		expect(same.action).toBe('unchanged');
		expect(await store.get(pid, created.id)).toEqual(before);
		expect(put).not.toHaveBeenCalled();
		expect(JSON.stringify(initial)).not.toContain('sensitive-value');
	});
	it('creates disabled and separates enabled changes from config versions', async () => {
		const { store, pid } = setup();
		const created = await apply(store, pid, { ...desired, enabled: false });
		expect((await store.get(pid, created.id)).enabled).toBe(false);
		expect(await apply(store, pid)).toMatchObject({
			action: 'updated',
			current_version: 1,
			config_changed: false,
		});
		expect(
			await apply(store, pid, { ...desired, config: { ...desired.config, password: 'rotated' } }),
		).toMatchObject({ action: 'updated', current_version: 2, config_changed: true });
	});
	it('enforces insert, ensure, kind identity and complete desired configs', async () => {
		const { store, pid } = setup();
		const created = await apply(store, pid);
		await expect(apply(store, pid, { ...desired, mode: 'insert' })).rejects.toMatchObject({
			code: 'CONFLICT',
		});
		expect(
			await apply(store, pid, {
				...desired,
				mode: 'ensure',
				config: { ...desired.config, host: 'other.internal' },
			}),
		).toMatchObject({ action: 'unchanged' });
		expect((await store.get(pid, created.id)).config.host).toBe('db.internal');
		await expect(apply(store, pid, { ...desired, kind: 'mysql' })).rejects.toMatchObject({
			code: 'CONFLICT',
		});
		await expect(apply(store, pid, { ...desired, config: {} })).rejects.toMatchObject({
			code: 'VALIDATION_ERROR',
		});
	});
	it('rejects stale unchanged plans and delete/recreate under the same name', async () => {
		const { store, pid } = setup();
		const first = await apply(store, pid);
		const plan = await store.planReconciliation(pid, desired);
		await store.update(pid, first.id, { enabled: false }, ACTOR);
		await expect(
			store.applyReconciliation(pid, desired, plan.precondition, ACTOR),
		).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
		await store.delete(pid, first.id);
		await apply(store, pid);
		await expect(
			store.applyReconciliation(pid, desired, plan.precondition, ACTOR),
		).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
	});
	it('requires explicit organization override and preserves the org record', async () => {
		const { store, org, pid } = setup();
		const inherited = await org.create(desired, ACTOR);
		await expect(apply(store, pid)).rejects.toMatchObject({ code: 'CONFLICT' });
		const override = await apply(store, pid, {
			...desired,
			allowOrgOverride: true,
			enabled: false,
		});
		expect(override.id).not.toBe(inherited.id);
		expect(await org.get(inherited.id)).toEqual(inherited);
		expect((await store.list(pid)).find((entry) => entry.id === inherited.id)?.shadowed).toBe(true);
	});
	it('compares references without resolving them and supports managed keep', async () => {
		const { store, resolve, pid } = setup();
		const reference = {
			...desired,
			config: {
				...desired.config,
				password: { $secret: { kind: 'reference', backend: 'vault', locator: 'secret-location' } },
			},
		};
		await apply(store, pid, reference);
		expect((await apply(store, pid, reference)).action).toBe('unchanged');
		expect(resolve).not.toHaveBeenCalled();
		await apply(store, pid);
		expect(
			(
				await apply(store, pid, {
					...desired,
					config: { ...desired.config, password: { $secret: { kind: 'managed', set: true } } },
				})
			).action,
		).toBe('unchanged');
	});
	it('keeps managed secrets with stable array names across reorder', async () => {
		const bucket = new MemoryBucket();
		const registry = new IntegrationRegistry();
		registry.register(
			defineIntegration({
				kind: 'named',
				title: 'Named',
				description: '',
				category: 'other',
				brand: { color: '#000000' },
				schemaVersion: 1,
				configSchema: z.object({
					entries: z.array(z.object({ name: z.string(), value: zSecret() })),
				}),
				render: () => ({}),
			}),
		);
		const store = new ProjectIntegrationsStore({ bucket, registry, codec });
		const pid = createProjectId();
		const input = {
			name: 'named',
			kind: 'named',
			config: {
				entries: [
					{ name: 'A', value: 'one' },
					{ name: 'B', value: 'two' },
				],
			},
		};
		await apply(store, pid, input);
		const reordered = {
			...input,
			config: {
				entries: [
					{ name: 'B', value: { $secret: { set: true } } },
					{ name: 'A', value: { $secret: { set: true } } },
				],
			},
		};
		await apply(store, pid, reordered);
		expect(
			(
				await apply(store, pid, {
					...input,
					config: { entries: [...input.config.entries].reverse() },
				})
			).action,
		).toBe('unchanged');
	});
	it('does not adopt a provisional head without its authoritative name claim', async () => {
		const { store, bucket, pid } = setup();
		const created = await apply(store, pid);
		const objects = await bucket.list({ prefix: `projects/${pid}/integrations/_names/` });
		for (const object of objects.objects) await bucket.delete(object.key);
		await expect(store.planReconciliation(pid, desired)).rejects.toMatchObject({
			code: 'CONFLICT',
		});
		expect((await store.get(pid, created.id)).current_version).toBe(1);
	});
	it('publishes a disabled head directly and arbitrates competing creates', async () => {
		const { store, bucket, pid } = setup();
		const input = { ...desired, enabled: false };
		const first = await store.planReconciliation(pid, input);
		const second = await store.planReconciliation(pid, input);
		const original = bucket.put.bind(bucket);
		const heads: boolean[] = [];
		let arrivals = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key.endsWith('/integration.json')) {
				heads.push(z.object({ enabled: z.boolean() }).parse(JSON.parse(String(value))).enabled);
				const result = await original(key, value, options);
				arrivals++;
				if (arrivals === 2) release();
				await barrier;
				return result;
			}
			return original(key, value, options);
		});
		const outcomes = await Promise.allSettled([
			store.applyReconciliation(pid, input, first.precondition, ACTOR),
			store.applyReconciliation(pid, input, second.precondition, ACTOR),
		]);
		expect(heads).toEqual([false, false]);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
			reason: { code: 'CONFLICT' },
		});
		expect(await store.list(pid)).toHaveLength(1);
	});

	it('fences a mutation that occurs during secret comparison', async () => {
		const bucket = new MemoryBucket();
		const pid = createProjectId();
		let interrupt: (() => Promise<void>) | undefined;
		const store = new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec: {
				encrypt: (value, context) => codec.encrypt(value, context),
				decrypt: async (value, context) => {
					const callback = interrupt;
					interrupt = undefined;
					await callback?.();
					return codec.decrypt(value, context);
				},
			},
		});
		const created = await apply(store, pid);
		const update = { ...desired, config: { ...desired.config, host: 'new.internal' } };
		const plan = await store.planReconciliation(pid, update);
		interrupt = () => store.update(pid, created.id, { enabled: false }, ACTOR).then(() => {});
		await expect(
			store.applyReconciliation(pid, update, plan.precondition, ACTOR),
		).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
		expect(await store.get(pid, created.id)).toMatchObject({
			enabled: false,
			current_version: 1,
			config: { host: 'db.internal' },
		});
	});
});

it('rejects a keep marker on create or an unset stored secret without writes', async () => {
	const { bucket, store, pid } = setup();
	const optional = { ...desired, kind: 'clickhouse' };
	const keep = {
		...optional,
		config: { ...desired.config, password: { $secret: { kind: 'managed', set: true } } },
	};
	const put = vi.spyOn(bucket, 'put');
	await expect(store.planReconciliation(pid, keep)).rejects.toMatchObject({
		code: 'VALIDATION_ERROR',
	});
	expect(put).not.toHaveBeenCalled();
	const created = await apply(store, pid, {
		...optional,
		config: { host: 'db', database: 'db', username: 'u' },
	});
	const before = await store.get(pid, created.id);
	put.mockClear();
	await expect(apply(store, pid, keep)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
	expect(put).not.toHaveBeenCalled();
	expect(await store.get(pid, created.id)).toEqual(before);
});
it.each(['missing', 'broken'])(
	'rejects managed-secret comparison with a %s codec without writes or plaintext errors',
	async (mode) => {
		const { bucket, store, pid } = setup();
		await apply(store, pid);
		const unavailable = new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec:
				mode === 'missing'
					? undefined
					: {
							encrypt: (value, context) => codec.encrypt(value, context),
							decrypt: async () => {
								throw new Error('sensitive-value');
							},
						},
		});
		const put = vi.spyOn(bucket, 'put');
		const failure = await unavailable
			.planReconciliation(pid, {
				...desired,
				config: { ...desired.config, password: { $secret: { kind: 'managed', set: true } } },
			})
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(String(failure)).not.toContain('sensitive-value');
		expect(put).not.toHaveBeenCalled();
	},
);
it.each(['missing', 'denied'])(
	'rejects a %s reference backend before persistence',
	async (mode) => {
		const bucket = new MemoryBucket();
		const resolve = vi.fn(async () => 'sensitive-value');
		const store = new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec,
			resolvers:
				mode === 'missing'
					? []
					: [
							{
								backend: 'vault',
								title: 'Vault',
								locatorPlaceholder: '',
								locatorHelp: '',
								resolve,
								authorize: () => {
									throw new Error('sensitive-policy');
								},
							},
						],
		});
		const put = vi.spyOn(bucket, 'put');
		const failure = await store
			.applyReconciliation(
				createProjectId(),
				{
					...desired,
					config: {
						...desired.config,
						password: { $secret: { kind: 'reference', backend: 'vault', locator: 'secret' } },
					},
				},
				{ state: 'absent' },
				ACTOR,
			)
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(String(failure)).not.toContain('sensitive-policy');
		expect(put).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	},
);
it('ignores note-only and key-order changes but removes omitted fields and restores defaults', async () => {
	const { store, pid, bucket } = setup();
	const optional = { ...desired, kind: 'clickhouse' };
	const created = await apply(store, pid, {
		...optional,
		config: { ...desired.config, port: 5433 },
	});
	const put = vi.spyOn(bucket, 'put');
	expect(
		(
			await apply(store, pid, {
				...optional,
				change_note: 'note only',
				config: { port: 5433, ...Object.fromEntries(Object.entries(desired.config).reverse()) },
			})
		).action,
	).toBe('unchanged');
	expect(put).not.toHaveBeenCalled();
	const removed = {
		...optional,
		config: { host: 'db.internal', database: 'analytics', username: 'reader' },
	};
	expect(await apply(store, pid, removed)).toMatchObject({
		current_version: 2,
		config_changed: true,
	});
	const stored = await store.get(pid, created.id);
	expect(stored.config.port).toBe(8443);
	expect(stored.config).not.toHaveProperty('password');
	expect((await apply(store, pid, removed)).action).toBe('unchanged');
});

it('compares distinct Unicode object keys independently of insertion order', () => {
	const before = { nested: { é: 1, 'e\u0301': 2 } };
	const after = { nested: { 'e\u0301': 2, é: 1 } };
	expect(changedConfigPaths(before, after)).toEqual([]);
	expect(changedConfigPaths(before, { nested: { 'e\u0301': 1, é: 2 } })).toEqual(['config.nested']);
});
