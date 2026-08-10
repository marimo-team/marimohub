import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	BadRequestError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
} from '../../errors';
import { createIntegrationId, createProjectId, createSessionId } from '../../ids';
import type { ProjectId, SessionId } from '../../ids';
import { paths } from '../../paths';
import type { Bucket, BucketListOptions } from '../../ports/bucket';
import { SecretResolutionError } from '../../ports/secrets';
import type { SecretResolver } from '../../ports/secrets';
import { ACTOR, MemoryBucket } from '../../testing';
import { AesGcmSecretCodec } from '../secrets/AesGcmSecretCodec';
import { INTEGRATIONS_DIR, INTEGRATIONS_DIR_ENV } from './bundle';
import { defaultRegistry } from './kinds';
import {
	MAX_INTEGRATIONS_PER_SCOPE,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
} from './ProjectIntegrationsStore';
import { IntegrationRegistry } from './registry';
import { defineIntegration, envSegment } from './sdk';
import { zSecret } from './secretFields';

const codec = new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' });

/** Test kind with a secret field and deterministic env/file output. */
const echoKind = defineIntegration({
	kind: 'echo',
	title: 'Echo',
	description: 'test kind',
	category: 'other',
	brand: { color: '#000000' },
	schemaVersion: 1,
	configSchema: z.object({
		greeting: z.string().default('hi'),
		token: zSecret(),
	}),
	render({ config, instanceName }) {
		const seg = envSegment(instanceName);
		return {
			env: { [`ECHO_${seg}_GREETING`]: config.greeting, [`ECHO_${seg}_TOKEN`]: config.token },
			files: [{ path: `echo/${instanceName}.txt`, content: config.greeting }],
			manifestExtra: { greeting: config.greeting },
		};
	},
	async testConnection(config) {
		return { ok: config.token === 'valid', details: `greeting=${config.greeting}` };
	},
});

const stubProbe = { fetch: () => Promise.reject(new Error('no network in tests')) };

function makeStore(bucket: MemoryBucket, withCodec = true, resolvers: SecretResolver[] = []) {
	const registry = new IntegrationRegistry();
	registry.register(echoKind);
	return new ProjectIntegrationsStore({
		bucket,
		registry,
		codec: withCodec ? codec : undefined,
		resolvers,
		probe: stubProbe,
	});
}

const vaultResolver: SecretResolver = {
	backend: 'vault',
	title: 'Vault',
	locatorPlaceholder: 'path/to/secret',
	locatorHelp: 'Use a Vault secret path.',
	resolve: async ({ locator }) => `resolved:${locator}`,
};

function pagedDelimiterBucket(inner: Bucket, pageSize: number): Bucket {
	return {
		get: (key) => inner.get(key),
		head: (key) => inner.head(key),
		put: (key, value, options) => inner.put(key, value, options),
		delete: (key) => inner.delete(key),
		async list(options: BucketListOptions = {}) {
			if (!options.delimiter) return inner.list(options);
			const { cursor, ...firstPage } = options;
			const complete = await inner.list(firstPage);
			const offset = cursor === undefined ? 0 : Number(cursor.slice('test-page:'.length));
			const delimitedPrefixes = complete.delimitedPrefixes.slice(offset, offset + pageSize);
			const next = offset + delimitedPrefixes.length;
			const truncated = next < complete.delimitedPrefixes.length;
			return {
				objects: [],
				delimitedPrefixes,
				truncated,
				...(truncated ? { cursor: `test-page:${next}` } : {}),
			};
		},
	};
}

/** A strictly ticking clock, so consecutive writes never share an `updated_at`. */
function ticking(): () => string {
	let tick = 0;
	return () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString();
}

const renderContext = (sessionId: SessionId) => ({
	sessionId,
	principal: { userId: ACTOR, email: 'user@example.com' },
});

describe('ProjectIntegrationsStore', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;

	beforeEach(() => {
		bucket = new MemoryBucket();
		pid = createProjectId();
	});

	it('creates an instance: defaults applied, secrets redacted, enabled by default', async () => {
		const store = makeStore(bucket);
		const detail = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 'sekret' } },
			ACTOR,
		);
		expect(detail).toMatchObject({
			kind: 'echo',
			name: 'prod',
			enabled: true,
			current_version: 1,
			config: { greeting: 'hi', token: { $secret: { set: true } } },
		});
		// Plaintext must never reach any bucket object.
		for (const object of (await bucket.list({})).objects) {
			const body = await bucket.get(object.key);
			expect(await body?.text(), object.key).not.toContain('sekret');
		}
	});

	it('rejects unknown kinds, invalid names, and duplicate names', async () => {
		const store = makeStore(bucket);
		await expect(store.create(pid, { kind: 'nope', name: 'a', config: {} }, ACTOR)).rejects.toThrow(
			ValidationError,
		);
		await expect(
			store.create(pid, { kind: 'echo', name: 'Bad Name', config: { token: 't' } }, ACTOR),
		).rejects.toThrow(/Invalid integration name/);
		await store.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR);
		await expect(
			store.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR),
		).rejects.toThrow(/already exists/);
	});

	it('follows every delimiter page and enforces the per-scope bound', async () => {
		const createdAt = new Date(1_700_000_000_000).toISOString();
		for (let index = 0; index <= MAX_INTEGRATIONS_PER_SCOPE; index++) {
			const id = createIntegrationId();
			await bucket.put(
				paths.project(pid).integration(id).head,
				JSON.stringify({
					id,
					project_id: pid,
					kind: 'echo',
					name: `item-${index}`,
					enabled: true,
					current_version: 1,
					created_by: ACTOR,
					created_at: createdAt,
					updated_at: createdAt,
				}),
			);
		}
		const paged = new ProjectIntegrationsStore({
			bucket: pagedDelimiterBucket(bucket, 37),
			registry: defaultRegistry(),
			codec,
		});

		await expect(paged.list(pid)).rejects.toThrow(ResourceExhaustedError);
		await bucket.delete(
			(await bucket.list({ prefix: paths.project(pid).integrationsPrefix })).objects[0].key,
		);
		for (let index = 0; index < 3; index++) {
			const id = createIntegrationId();
			await bucket.put(
				paths.project(pid).integration(id).head,
				JSON.stringify({
					id,
					project_id: pid,
					kind: 'echo',
					name: `deleted-${index}`,
					enabled: true,
					current_version: 1,
					created_by: ACTOR,
					created_at: createdAt,
					updated_at: createdAt,
					deleted_at: createdAt,
				}),
			);
		}
		expect(await paged.list(pid)).toHaveLength(MAX_INTEGRATIONS_PER_SCOPE);
	});

	it('skips heads deleted after listing and committed tombstones', async () => {
		const store = makeStore(bucket);
		const deleted = await store.create(
			pid,
			{ kind: 'echo', name: 'deleted', config: { token: 't' } },
			ACTOR,
		);
		const tombstoned = await store.create(
			pid,
			{ kind: 'echo', name: 'tombstoned', config: { token: 't' } },
			ACTOR,
		);
		const kept = await store.create(
			pid,
			{ kind: 'echo', name: 'kept', config: { token: 't' } },
			ACTOR,
		);
		const deletedKey = paths.project(pid).integration(deleted.id).head;
		const tombstoneKey = paths.project(pid).integration(tombstoned.id).head;
		const tombstone = await (await bucket.get(tombstoneKey))!.json<Record<string, unknown>>();
		await bucket.put(
			tombstoneKey,
			JSON.stringify({ ...tombstone, deleted_at: new Date().toISOString() }),
		);
		let raced = false;
		const racing: Bucket = {
			get: async (key) => {
				if (key === deletedKey && !raced) {
					raced = true;
					await bucket.delete(key);
					return null;
				}
				return bucket.get(key);
			},
			head: (key) => bucket.head(key),
			put: (key, value, options) => bucket.put(key, value, options),
			delete: (key) => bucket.delete(key),
			list: (options) => bucket.list(options),
		};

		const listed = await new ProjectIntegrationsStore({
			bucket: racing,
			registry: defaultRegistry(),
			codec,
		}).list(pid);
		expect(listed.map((entry) => entry.id)).toEqual([kept.id]);
	});

	it('fails closed when a listed head is corrupt', async () => {
		const created = await makeStore(bucket).create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const key = paths.project(pid).integration(created.id).head;
		const head = await (await bucket.get(key))!.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...head, current_version: 0 }));

		await expect(makeStore(bucket).list(pid)).rejects.toThrow(
			'Stored data is temporarily unavailable',
		);
	});

	it('does not expose secret values thrown by an integration renderer', async () => {
		const leaked = 'renderer-secret';
		const registry = new IntegrationRegistry();
		registry.register(
			defineIntegration({
				kind: 'leaky',
				title: 'Leaky',
				description: 'test kind',
				category: 'other',
				brand: { color: '#000000' },
				schemaVersion: 1,
				configSchema: z.object({ token: zSecret() }),
				render({ config }) {
					throw new Error(`provider failed with ${config.token}`);
				},
			}),
		);
		const store = new ProjectIntegrationsStore({ bucket, registry, codec });
		await store.create(pid, { kind: 'leaky', name: 'prod', config: { token: leaked } }, ACTOR);

		let error: unknown;
		try {
			await store.resolveForSession(pid, renderContext(createSessionId()));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ValidationError);
		expect(String(error)).not.toContain(leaked);
	});

	it('update with config appends an immutable version and bumps the pointer', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 'one' } },
			ACTOR,
		);
		const updated = await store.update(
			pid,
			created.id,
			{ config: { greeting: 'hello', token: 'two' }, change_note: 'rotate' },
			ACTOR,
		);
		expect(updated.current_version).toBe(2);
		expect(updated.config.greeting).toBe('hello');
		expect(updated.change_note).toBe('rotate');

		const versions = await store.listVersions(pid, created.id);
		expect(versions.items.map((v) => v.version)).toEqual([2, 1]);

		// Appending version 2 must not rewrite version 1.
		const v1 = await bucket.get(paths.project(pid).integration(created.id).version(1));
		expect(v1).not.toBeNull();
	});

	it('merge-keep: an untouched { $secret: { set: true } } keeps the stored value', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 'keep-me' } },
			ACTOR,
		);
		await store.update(
			pid,
			created.id,
			{ config: { greeting: 'edited', token: { $secret: { set: true } } } },
			ACTOR,
		);
		const render = await store.resolveForSession(pid, renderContext(createSessionId()));
		expect(render?.vars.ECHO_PROD_TOKEN).toBe('keep-me');
		expect(render?.vars.ECHO_PROD_GREETING).toBe('edited');
	});

	it('matches retained JSON bundles by stable name after reordering rows', async () => {
		const store = new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec,
			probe: stubProbe,
		});
		const created = await store.create(
			pid,
			{
				kind: 'custom_env',
				name: 'env',
				config: {
					secret_bundles: [
						{ name: 'A', prefix: 'A_', value: '{"TOKEN":"secret-a"}' },
						{ name: 'B', prefix: 'B_', value: '{"TOKEN":"secret-b"}' },
					],
				},
			},
			ACTOR,
		);
		await store.update(
			pid,
			created.id,
			{
				config: {
					secret_bundles: [
						{ name: 'B', prefix: 'B_', value: { $secret: { kind: 'managed', set: true } } },
						{ name: 'A', prefix: 'A_', value: { $secret: { kind: 'managed', set: true } } },
					],
				},
			},
			ACTOR,
		);

		const render = await store.resolveForSession(pid, renderContext(createSessionId()));
		expect(render?.vars).toMatchObject({ A_TOKEN: 'secret-a', B_TOKEN: 'secret-b' });
	});

	it('keeps the correct JSON bundle secret after deleting an earlier row', async () => {
		const store = new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec,
			probe: stubProbe,
		});
		const created = await store.create(
			pid,
			{
				kind: 'custom_env',
				name: 'env',
				config: {
					secret_bundles: [
						{ name: 'A', prefix: 'A_', value: '{"TOKEN":"secret-a"}' },
						{ name: 'B', prefix: 'B_', value: '{"TOKEN":"secret-b"}' },
					],
				},
			},
			ACTOR,
		);
		await store.update(
			pid,
			created.id,
			{
				config: {
					secret_bundles: [
						{ name: 'B', prefix: 'B_', value: { $secret: { kind: 'managed', set: true } } },
					],
				},
			},
			ACTOR,
		);

		const render = await store.resolveForSession(pid, renderContext(createSessionId()));
		expect(render?.vars.B_TOKEN).toBe('secret-b');
		expect(render?.vars.A_TOKEN).toBeUndefined();
	});

	it('concurrent config updates land as distinct versions with the highest winning', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		await Promise.all([
			store.update(pid, created.id, { config: { greeting: 'a', token: 'ta' } }, ACTOR),
			store.update(pid, created.id, { config: { greeting: 'b', token: 'tb' } }, ACTOR),
		]);
		const detail = await store.get(pid, created.id);
		expect(detail.current_version).toBe(3);
		const versions = await store.listVersions(pid, created.id);
		expect(versions.items.map((v) => v.version)).toEqual([3, 2, 1]);
	});

	it('create removes its version when writing the head fails', async () => {
		const increment = vi.fn();
		const failing: Bucket = {
			get: (key) => bucket.get(key),
			head: (key) => bucket.head(key),
			delete: (key) => bucket.delete(key),
			list: (options) => bucket.list(options),
			put: (key, value, options) => {
				if (key.endsWith('/integration.json')) {
					return Promise.reject(new Error('head write failed'));
				}
				return bucket.put(key, value, options);
			},
		};
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const store = new ProjectIntegrationsStore({
			bucket: failing,
			registry,
			codec,
			probe: stubProbe,
			metrics: { increment, gauge: vi.fn() },
		});

		await expect(
			store.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR),
		).rejects.toThrow(/head write failed/);
		expect((await bucket.list({ prefix: paths.project(pid).integrationsPrefix })).objects).toEqual(
			[],
		);
		expect(increment).toHaveBeenCalledWith('saga.integration_create.write_version_compensated');
	});

	it('prepares a rename and config update concurrently before writing', async () => {
		const base = makeStore(bucket);
		const created = await base.create(
			pid,
			{ kind: 'echo', name: 'before', config: { token: 't' } },
			ACTOR,
		);
		let releaseNameScan!: () => void;
		const nameScanGate = new Promise<void>((resolve) => {
			releaseNameScan = resolve;
		});
		let nameScanStarted!: () => void;
		const sawNameScan = new Promise<void>((resolve) => {
			nameScanStarted = resolve;
		});
		let versionReadStarted = false;
		const wrapped: Bucket = {
			get: (key) => {
				if (key.endsWith('/versions/000001.json')) versionReadStarted = true;
				return bucket.get(key);
			},
			head: (key) => bucket.head(key),
			delete: (key) => bucket.delete(key),
			list: async (options) => {
				if (options?.delimiter === '/' && options.prefix?.endsWith('/integrations/')) {
					nameScanStarted();
					await nameScanGate;
				}
				return bucket.list(options);
			},
			put: (key, value, options) => bucket.put(key, value, options),
		};
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const store = new ProjectIntegrationsStore({ bucket: wrapped, registry, codec });

		const update = store.update(
			pid,
			created.id,
			{
				name: 'after',
				config: { greeting: 'updated', token: { $secret: { set: true } } },
			},
			ACTOR,
		);
		await sawNameScan;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const overlapped = versionReadStarted;
		releaseNameScan();
		await update;

		expect(overlapped).toBe(true);
	});

	it('toggle enabled without a config change appends no version', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const updated = await store.update(pid, created.id, { enabled: false }, ACTOR);
		expect(updated.enabled).toBe(false);
		expect(updated.current_version).toBe(1);
	});

	it('delete removes head + versions and is idempotent', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		await store.update(pid, created.id, { config: { token: 't2' } }, ACTOR);
		// The repeat succeeds but reports that nothing was removed.
		await expect(store.delete(pid, created.id)).resolves.toBe(true);
		await expect(store.delete(pid, created.id)).resolves.toBe(false);
		await expect(store.get(pid, created.id)).rejects.toThrow(NotFoundError);
		expect(await store.list(pid)).toEqual([]);
	});

	it('deletes a malformed head and logs without its bytes', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const integrationPaths = paths.project(pid).integration(created.id);
		await bucket.put(integrationPaths.head, '{"secret":"do-not-log"');
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			await expect(store.delete(pid, created.id)).resolves.toBe(true);
			expect(await bucket.list({ prefix: integrationPaths.base })).toMatchObject({ objects: [] });
			const line = log.mock.calls[0]?.[0] as string;
			expect(line).toContain('corrupt_integration_head_deleted');
			expect(line).not.toContain('do-not-log');
		} finally {
			log.mockRestore();
		}
	});

	it('resolveForSession renders enabled instances only; none → undefined', async () => {
		const store = makeStore(bucket);
		expect(await store.resolveForSession(pid, renderContext(createSessionId()))).toBeUndefined();

		const a = await store.create(pid, { kind: 'echo', name: 'aaa', config: { token: 'x' } }, ACTOR);
		await store.create(pid, { kind: 'echo', name: 'bbb', config: { token: 'y' } }, ACTOR);
		await store.update(pid, a.id, { enabled: false }, ACTOR);

		const sessionId = createSessionId();
		const render = await store.resolveForSession(pid, renderContext(sessionId));
		expect(render?.attachments).toEqual([
			{ id: expect.any(String), name: 'bbb', kind: 'echo', version: 1 },
		]);
		expect(render?.vars).toMatchObject({
			ECHO_BBB_TOKEN: 'y',
			[INTEGRATIONS_DIR_ENV]: INTEGRATIONS_DIR,
		});
		expect(render?.vars.ECHO_AAA_TOKEN).toBeUndefined();

		const manifest = render?.files.find((f) => f.path === `${INTEGRATIONS_DIR}/manifest.json`);
		expect(manifest).toBeDefined();
		expect(JSON.parse(manifest?.content ?? '')).toEqual({
			session_id: sessionId,
			integrations: [{ name: 'bbb', kind: 'echo', version: 1, extra: { greeting: 'hi' } }],
		});
		expect(render?.files.some((f) => f.path === `${INTEGRATIONS_DIR}/echo/bbb.txt`)).toBe(true);
	});

	it('resolveForSession records only the packages selected by the config', async () => {
		const store = new ProjectIntegrationsStore({ bucket, registry: defaultRegistry(), codec });
		await store.create(
			pid,
			{
				kind: 'sqlserver',
				name: 'warehouse',
				config: {
					host: 'mssql.internal',
					database: 'analytics',
					username: 'reader',
					password: 'secret',
					driver: { name: 'pymssql' },
				},
			},
			ACTOR,
		);

		const render = await store.resolveForSession(pid, renderContext(createSessionId()));
		const manifest = render?.files.find(
			(file) => file.path === `${INTEGRATIONS_DIR}/manifest.json`,
		);
		expect(JSON.parse(manifest?.content ?? '')).toMatchObject({
			integrations: [{ requirements: ['sqlalchemy>=2', 'pymssql>=2.3'] }],
		});
	});

	it('without a codec, creating with a secret names the missing config', async () => {
		const store = makeStore(bucket, false);
		await expect(
			store.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR),
		).rejects.toThrow(/MARIMOHUB_SECRETS_KEK/);
	});

	it('advertises configured secret sources and validates external backends on save', async () => {
		const store = makeStore(bucket, true, [vaultResolver]);
		expect(store.listKinds()[0].secret_sources).toEqual({
			inline: true,
			references: [
				{
					backend: 'vault',
					title: 'Vault',
					locator_placeholder: 'path/to/secret',
					locator_help: 'Use a Vault secret path.',
				},
			],
		});
		await expect(
			store.create(
				pid,
				{
					kind: 'echo',
					name: 'prod',
					config: {
						token: {
							$secret: { kind: 'reference', backend: 'missing', locator: 'hidden/path' },
						},
					},
				},
				ACTOR,
			),
		).rejects.toThrow(/Unknown secret backend "missing"/);
	});

	it('resolves references only when testing or rendering and sanitizes failures', async () => {
		const locator = 'hidden/path#token';
		const providerMessage = 'provider response contained plaintext';
		const resolve = vi.fn(async () => {
			throw new Error(providerMessage);
		});
		const store = makeStore(bucket, true, [{ ...vaultResolver, resolve }]);
		const created = await store.create(
			pid,
			{
				kind: 'echo',
				name: 'prod',
				config: {
					token: { $secret: { kind: 'reference', backend: 'vault', locator } },
				},
			},
			ACTOR,
		);
		expect(resolve).not.toHaveBeenCalled();
		expect((await store.get(pid, created.id)).config.token).toEqual({
			$secret: { kind: 'reference', backend: 'vault', locator },
		});
		for (const operation of [
			() => store.test(pid, { source: 'stored' as const, id: created.id }),
			() => store.resolveForSession(pid, renderContext(createSessionId())),
		]) {
			let error: unknown;
			try {
				await operation();
			} catch (caught) {
				error = caught;
			}
			expect(String(error)).not.toContain(locator);
			expect(String(error)).not.toContain(providerMessage);
			expect(String(error)).toContain('backend "vault"');
			expect(error).toBeInstanceOf(UnavailableError);
		}
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('reports an invalid secret reference as validation failure', async () => {
		const resolve = vi.fn(async () => {
			throw new SecretResolutionError('not_found', 'missing');
		});
		const store = makeStore(bucket, true, [{ ...vaultResolver, resolve }]);
		const created = await store.create(
			pid,
			{
				kind: 'echo',
				name: 'prod',
				config: {
					token: {
						$secret: { kind: 'reference', backend: 'vault', locator: 'missing' },
					},
				},
			},
			ACTOR,
		);
		await expect(store.test(pid, { source: 'stored', id: created.id })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	it('resolves a stored reference before running its connection test', async () => {
		const resolve = vi.fn(async () => 'valid');
		const store = makeStore(bucket, true, [{ ...vaultResolver, resolve }]);
		const created = await store.create(
			pid,
			{
				kind: 'echo',
				name: 'prod',
				config: {
					greeting: 'stored',
					token: {
						$secret: { kind: 'reference', backend: 'vault', locator: 'hidden/path' },
					},
				},
			},
			ACTOR,
		);

		await expect(store.test(pid, { source: 'stored', id: created.id })).resolves.toEqual({
			ok: true,
			details: 'greeting=stored',
		});
		expect(resolve).toHaveBeenCalledWith({ backend: 'vault', locator: 'hidden/path' });
	});

	it('test() runs the probe on unsaved config without persisting anything', async () => {
		const store = makeStore(bucket);
		const result = await store.test(pid, {
			source: 'draft',
			kind: 'echo',
			config: { greeting: 'yo', token: 'valid' },
		});
		expect(result).toEqual({ ok: true, details: 'greeting=yo' });
		expect(await store.list(pid)).toEqual([]);
		// Unsaved probes use the transient sealer and do not require a deployment codec.
		const codecless = makeStore(bucket, false);
		expect(
			(
				await codecless.test(pid, {
					source: 'draft',
					kind: 'echo',
					config: { token: 'nope' },
				})
			).ok,
		).toBe(false);
	});

	it('test({ id }) probes the stored config', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 'valid' } },
			ACTOR,
		);
		expect((await store.test(pid, { source: 'stored', id: created.id })).ok).toBe(true);
	});

	it('tests edited draft fields while resolving managed keep-markers from storage', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { greeting: 'old', token: 'valid' } },
			ACTOR,
		);
		const result = await store.test(pid, {
			source: 'draft',
			id: created.id,
			kind: 'echo',
			config: { greeting: 'edited', token: { $secret: { kind: 'managed', set: true } } },
		});
		expect(result).toEqual({ ok: true, details: 'greeting=edited' });
	});

	it('without a probe, testing is disabled and kinds report supports_test: false', async () => {
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const store = new ProjectIntegrationsStore({ bucket, registry, codec });
		expect(store.listKinds().map((k) => k.supports_test)).toEqual([false]);
		await expect(
			store.test(pid, { source: 'draft', kind: 'echo', config: { token: 'valid' } }),
		).rejects.toThrow(/testing is not enabled/i);
	});

	describe('schema migration in every read path', () => {
		const migrating = defineIntegration({
			kind: 'echo',
			title: 'Echo',
			description: 'test kind',
			category: 'other',
			brand: { color: '#000000' },
			schemaVersion: 2,
			configSchema: z.object({ greeting2: z.string(), token: zSecret() }),
			render({ config, instanceName }) {
				const seg = envSegment(instanceName);
				return {
					env: { [`ECHO_${seg}_GREETING`]: config.greeting2, [`ECHO_${seg}_TOKEN`]: config.token },
				};
			},
			migrate(stored, fromVersion) {
				expect(fromVersion).toBe(1);
				const old = stored as { greeting: string; token: unknown };
				return { greeting2: `${old.greeting}!`, token: old.token };
			},
		});

		function v2store() {
			const upgraded = new IntegrationRegistry();
			upgraded.register(migrating);
			return new ProjectIntegrationsStore({ bucket, registry: upgraded, codec });
		}

		async function createV1() {
			return makeStore(bucket).create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 'keep-me' } },
				ACTOR,
			);
		}

		it('render migrates through the chain, or fails loudly without one', async () => {
			await createV1();
			const render = await v2store().resolveForSession(pid, renderContext(createSessionId()));
			expect(render?.vars.ECHO_PROD_GREETING).toBe('hi!');

			const noMigrate = new IntegrationRegistry();
			noMigrate.register(defineIntegration({ ...migrating, migrate: undefined }));
			const broken = new ProjectIntegrationsStore({ bucket, registry: noMigrate, codec });
			await expect(broken.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
				/no migration path/,
			);
		});

		it('get() returns the migrated shape with current-path redaction', async () => {
			const created = await createV1();
			const detail = await v2store().get(pid, created.id);
			expect(detail.config).toEqual({
				greeting2: 'hi!',
				token: { $secret: { kind: 'managed', set: true } },
			});
		});

		it('merge-keep resolves against the migrated previous config', async () => {
			const created = await createV1();
			const store = v2store();
			await store.update(
				pid,
				created.id,
				{ config: { greeting2: 'edited', token: { $secret: { set: true } } } },
				ACTOR,
			);
			const render = await store.resolveForSession(pid, renderContext(createSessionId()));
			expect(render?.vars.ECHO_PROD_TOKEN).toBe('keep-me');
			expect(render?.vars.ECHO_PROD_GREETING).toBe('edited');
		});

		it('get rejects migration output that does not satisfy the current schema', async () => {
			const created = await createV1();
			const invalid = new IntegrationRegistry();
			invalid.register(
				defineIntegration({
					...migrating,
					migrate: () => ({ greeting2: 42, token: { $secret: { set: true } } }),
				}),
			);
			const store = new ProjectIntegrationsStore({ bucket, registry: invalid, codec });

			await expect(store.get(pid, created.id)).rejects.toThrow(ValidationError);
		});

		it('rejects a config written by a NEWER kind schema than this deployment knows', async () => {
			const created = await makeStore(bucket).create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			const key = paths.project(pid).integration(created.id).version(1);
			const record = await (await bucket.get(key))?.json<Record<string, unknown>>();
			await bucket.put(key, JSON.stringify({ ...record, kind_schema_version: 99 }));

			const store = makeStore(bucket);
			await expect(store.get(pid, created.id)).rejects.toThrow(/newer than/);
			await expect(store.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
				/newer than/,
			);
		});
	});

	describe('name uniqueness claims', () => {
		it('concurrent same-name creates: exactly one wins, the loser leaves no objects', async () => {
			const store = makeStore(bucket);
			const results = await Promise.allSettled([
				store.create(pid, { kind: 'echo', name: 'prod', config: { token: 'a' } }, ACTOR),
				store.create(pid, { kind: 'echo', name: 'prod', config: { token: 'b' } }, ACTOR),
			]);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

			expect(await store.list(pid)).toHaveLength(1);
			const heads = (await bucket.list({ prefix: `projects/${pid}/integrations/` })).objects.filter(
				(o) => o.key.endsWith('/integration.json'),
			);
			expect(heads).toHaveLength(1);
		});

		it('rename claims the new name, frees the old, and reverts on conflict', async () => {
			const store = makeStore(bucket);
			const a = await store.create(
				pid,
				{ kind: 'echo', name: 'aaa', config: { token: 't' } },
				ACTOR,
			);
			await store.create(pid, { kind: 'echo', name: 'bbb', config: { token: 't' } }, ACTOR);

			await expect(store.update(pid, a.id, { name: 'bbb' }, ACTOR)).rejects.toThrow(
				/already exists/,
			);
			expect((await store.get(pid, a.id)).name).toBe('aaa');

			await store.update(pid, a.id, { name: 'ccc' }, ACTOR);
			await store.create(pid, { kind: 'echo', name: 'aaa', config: { token: 't' } }, ACTOR);
		});

		it('delete frees the name for reuse', async () => {
			const store = makeStore(bucket);
			const created = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			await store.delete(pid, created.id);
			await store.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR);
		});

		it('an orphaned claim with no live head self-heals on the next create', async () => {
			await bucket.put(
				paths.project(pid).integrationNameClaim('ghost'),
				JSON.stringify({ integration_id: 'intg-0000000000000000', claimed_at: 'x' }),
			);
			const store = makeStore(bucket);
			await store.create(pid, { kind: 'echo', name: 'ghost', config: { token: 't' } }, ACTOR);
		});

		it('a rename+config PATCH with an INVALID config commits nothing (not even the rename)', async () => {
			const store = makeStore(bucket);
			const a = await store.create(
				pid,
				{ kind: 'echo', name: 'aaa', config: { token: 'ta' } },
				ACTOR,
			);
			// `token` is required — sealing fails before any write.
			await expect(
				store.update(pid, a.id, { name: 'renamed', config: { greeting: 'x' } }, ACTOR),
			).rejects.toThrow(/Invalid config/);

			const detail = await store.get(pid, a.id);
			expect(detail).toMatchObject({ name: 'aaa', current_version: 1 });
			expect((await store.listVersions(pid, a.id)).items.map((v) => v.version)).toEqual([1]);
			// The old name is still claimed; the target name never was.
			await expect(
				store.create(pid, { kind: 'echo', name: 'aaa', config: { token: 't' } }, ACTOR),
			).rejects.toThrow(/already exists/);
			await store.create(pid, { kind: 'echo', name: 'renamed', config: { token: 't' } }, ACTOR);
		});

		it('a combined rename+config update that loses the name commits NOTHING', async () => {
			const store = makeStore(bucket);
			const a = await store.create(
				pid,
				{ kind: 'echo', name: 'aaa', config: { token: 'ta' } },
				ACTOR,
			);
			await store.create(pid, { kind: 'echo', name: 'bbb', config: { token: 'tb' } }, ACTOR);
			await expect(
				store.update(
					pid,
					a.id,
					{ name: 'bbb', config: { greeting: 'oops', token: { $secret: { set: true } } } },
					ACTOR,
				),
			).rejects.toThrow(/already exists/);

			const detail = await store.get(pid, a.id);
			expect(detail).toMatchObject({ name: 'aaa', current_version: 1 });
			expect(detail.config.greeting).toBe('hi');
			expect((await store.listVersions(pid, a.id)).items.map((v) => v.version)).toEqual([1]);
		});

		it('an update racing a delete compensates its own appended version', async () => {
			const store = makeStore(bucket);
			const created = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			// Interleave: the delete completes while the update sits between its
			// version append and its head CAS.
			const raceBucket: Bucket = {
				get: (key) => bucket.get(key),
				head: (key) => bucket.head(key),
				delete: (key) => bucket.delete(key),
				list: (options) => bucket.list(options),
				put: async (key, value, options) => {
					if (key.endsWith('/versions/000002.json')) {
						await store.delete(pid, created.id);
					}
					return bucket.put(key, value, options);
				},
			};
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			const racing = new ProjectIntegrationsStore({
				bucket: raceBucket,
				registry,
				codec,
				probe: stubProbe,
			});
			await expect(
				racing.update(pid, created.id, { config: { token: 't2' } }, ACTOR),
			).rejects.toThrow(NotFoundError);
			const leftovers = await bucket.list({
				prefix: `projects/${pid}/integrations/${created.id}/`,
			});
			expect(leftovers.objects).toEqual([]);
		});

		it('a failed final head commit rolls back the rename, version, and new-name claim', async () => {
			const base = makeStore(bucket);
			const created = await base.create(
				pid,
				{ kind: 'echo', name: 'before', config: { token: 't' } },
				ACTOR,
			);
			let headCasWrites = 0;
			const failing: Bucket = {
				get: (key) => bucket.get(key),
				head: (key) => bucket.head(key),
				delete: (key) => bucket.delete(key),
				list: (options) => bucket.list(options),
				put: (key, value, options) => {
					if (key.endsWith('/integration.json') && options?.onlyIfEtagMatches) {
						headCasWrites += 1;
						if (headCasWrites === 2) {
							return Promise.reject(new Error('final head commit failed'));
						}
					}
					return bucket.put(key, value, options);
				},
			};
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			const store = new ProjectIntegrationsStore({
				bucket: failing,
				registry,
				codec,
				probe: stubProbe,
			});

			await expect(
				store.update(
					pid,
					created.id,
					{ name: 'after', config: { token: { $secret: { set: true } } } },
					ACTOR,
				),
			).rejects.toThrow(/final head commit failed/);
			expect(await base.get(pid, created.id)).toMatchObject({
				name: 'before',
				current_version: 1,
			});
			expect((await base.listVersions(pid, created.id)).items.map((v) => v.version)).toEqual([1]);
			await base.create(pid, { kind: 'echo', name: 'after', config: { token: 't' } }, ACTOR);
		});

		it('a rolled-back rename invalidates a token minted from the renamed head', async () => {
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			const base = new ProjectIntegrationsStore({
				bucket,
				registry,
				codec,
				probe: stubProbe,
				now: ticking(),
			});
			const created = await base.create(
				pid,
				{ kind: 'echo', name: 'before', config: { token: 't' } },
				ACTOR,
			);
			let headCasWrites = 0;
			let exposed: { name: string; updated_at: string } | undefined;
			const failing: Bucket = {
				get: (key) => bucket.get(key),
				head: (key) => bucket.head(key),
				delete: (key) => bucket.delete(key),
				list: (options) => bucket.list(options),
				put: async (key, value, options) => {
					if (key.endsWith('/integration.json') && options?.onlyIfEtagMatches) {
						headCasWrites += 1;
						if (headCasWrites === 2) {
							// The rename is committed and readable here: whatever a concurrent
							// reader sees now, it can echo back as an If-Match token.
							exposed = await (await bucket.get(key))?.json<{ name: string; updated_at: string }>();
							throw new Error('final head commit failed');
						}
					}
					return bucket.put(key, value, options);
				},
			};
			const store = new ProjectIntegrationsStore({
				bucket: failing,
				registry,
				codec,
				probe: stubProbe,
				now: ticking(),
			});

			await expect(store.update(pid, created.id, { name: 'after' }, ACTOR)).rejects.toThrow(
				/final head commit failed/,
			);
			expect(exposed?.name).toBe('after');
			const reverted = await base.get(pid, created.id);
			expect(reverted.name).toBe('before');
			// The rollback changed the name back, so the token that described the
			// renamed head must no longer match.
			await expect(
				base.update(pid, created.id, { enabled: false }, ACTOR, exposed?.updated_at),
			).rejects.toThrow(PreconditionFailedError);
			await base.update(pid, created.id, { enabled: false }, ACTOR, reverted.updated_at);
		});
	});

	it('update honors the If-Match precondition (412 when the head changed underneath)', async () => {
		// A strictly ticking clock, so consecutive writes can never share an
		// `updated_at` (the version token) within one millisecond.
		let tick = 0;
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const store = new ProjectIntegrationsStore({
			bucket,
			registry,
			codec,
			probe: stubProbe,
			now: () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString(),
		});
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const fresh = await store.update(pid, created.id, { enabled: false }, ACTOR);
		// Another editor's read from before that update is now stale.
		await expect(
			store.update(pid, created.id, { enabled: true }, ACTOR, created.updated_at),
		).rejects.toThrow(PreconditionFailedError);
		await store.update(pid, created.id, { enabled: true }, ACTOR, fresh.updated_at);
	});

	describe('If-Match under a losing head CAS', () => {
		/** A store whose head CAS lets `interloper` commit before its first attempt lands. */
		function racingStore(inner: ProjectIntegrationsStore, interloper: () => Promise<unknown>) {
			let raced = false;
			const wrapped: Bucket = {
				get: (key) => bucket.get(key),
				head: (key) => bucket.head(key),
				delete: (key) => bucket.delete(key),
				list: (options) => bucket.list(options),
				put: async (key, value, options) => {
					if (key.endsWith('/integration.json') && options?.onlyIfEtagMatches && !raced) {
						raced = true;
						await interloper();
					}
					return bucket.put(key, value, options);
				},
			};
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			return new ProjectIntegrationsStore({
				bucket: wrapped,
				registry,
				codec,
				probe: stubProbe,
				now: ticking(),
			});
		}

		function makeInner() {
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			return new ProjectIntegrationsStore({
				bucket,
				registry,
				codec,
				probe: stubProbe,
				now: ticking(),
			});
		}

		it('the CAS retry re-checks the token instead of clobbering the newer head', async () => {
			const inner = makeInner();
			const created = await inner.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			// Both PATCHes carry the token from `created`; the interloper commits first.
			const store = racingStore(inner, () =>
				inner.update(pid, created.id, { name: 'winner' }, ACTOR, created.updated_at),
			);

			await expect(
				store.update(pid, created.id, { enabled: false }, ACTOR, created.updated_at),
			).rejects.toThrow(PreconditionFailedError);
			expect(await inner.get(pid, created.id)).toMatchObject({ name: 'winner', enabled: true });
		});

		it('a stale rename commits neither the name nor its claim', async () => {
			const inner = makeInner();
			const created = await inner.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			const store = racingStore(inner, () =>
				inner.update(pid, created.id, { enabled: false }, ACTOR, created.updated_at),
			);

			await expect(
				store.update(pid, created.id, { name: 'renamed' }, ACTOR, created.updated_at),
			).rejects.toThrow(PreconditionFailedError);
			expect(await inner.get(pid, created.id)).toMatchObject({ name: 'prod', enabled: false });
			await inner.create(pid, { kind: 'echo', name: 'renamed', config: { token: 't' } }, ACTOR);
		});
	});

	it('delete honors the If-Match precondition and stays idempotent', async () => {
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const store = new ProjectIntegrationsStore({
			bucket,
			registry,
			codec,
			probe: stubProbe,
			now: ticking(),
		});
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const updated = await store.update(pid, created.id, { enabled: false }, ACTOR);

		await expect(store.delete(pid, created.id, created.updated_at)).rejects.toThrow(
			PreconditionFailedError,
		);
		expect(await store.get(pid, created.id)).toMatchObject({ name: 'prod' });

		await store.delete(pid, created.id, updated.updated_at);
		await expect(store.get(pid, created.id)).rejects.toThrow(NotFoundError);
		// Already gone: a stale token must not turn the idempotent replay into a 412.
		await store.delete(pid, created.id, created.updated_at);
	});

	describe('delete under a concurrent commit', () => {
		function storeOn(on: Bucket) {
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			return new ProjectIntegrationsStore({
				bucket: on,
				registry,
				codec,
				probe: stubProbe,
				now: ticking(),
			});
		}

		/** A store whose first head read is stale by the time it writes: `interloper` commits in between. */
		function racingDeleteStore(interloper: () => Promise<unknown>) {
			let raced = false;
			return storeOn({
				head: (key) => bucket.head(key),
				delete: (key) => bucket.delete(key),
				list: (options) => bucket.list(options),
				put: (key, value, options) => bucket.put(key, value, options),
				get: async (key) => {
					const body = await bucket.get(key);
					if (key.endsWith('/integration.json') && !raced) {
						raced = true;
						await interloper();
					}
					return body;
				},
			});
		}

		it('an update committing after the head read forces 412 and deletes nothing', async () => {
			const inner = storeOn(bucket);
			const created = await inner.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			const store = racingDeleteStore(() =>
				inner.update(pid, created.id, { config: { token: 't2' } }, ACTOR, created.updated_at),
			);

			await expect(store.delete(pid, created.id, created.updated_at)).rejects.toThrow(
				PreconditionFailedError,
			);
			expect(await inner.get(pid, created.id)).toMatchObject({ name: 'prod', current_version: 2 });
			expect((await inner.listVersions(pid, created.id)).items.map((v) => v.version)).toEqual([
				2, 1,
			]);
			// The losing delete must not free the name it never deleted.
			await expect(
				inner.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR),
			).rejects.toThrow(/already exists/);
		});

		it('without a precondition the delete retries past the update and removes everything', async () => {
			const inner = storeOn(bucket);
			const created = await inner.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			const store = racingDeleteStore(() =>
				inner.update(pid, created.id, { enabled: false }, ACTOR),
			);

			await store.delete(pid, created.id);
			await expect(inner.get(pid, created.id)).rejects.toThrow(NotFoundError);
			expect(
				(await bucket.list({ prefix: `projects/${pid}/integrations/${created.id}/` })).objects,
			).toEqual([]);
			await inner.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR);
		});

		it('a delete interrupted after the tombstone reads as gone and resumes', async () => {
			const store = storeOn(bucket);
			const created = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			const crashing = storeOn({
				get: (key) => bucket.get(key),
				head: (key) => bucket.head(key),
				list: (options) => bucket.list(options),
				put: (key, value, options) => bucket.put(key, value, options),
				delete: () => Promise.reject(new Error('bucket unavailable')),
			});
			await expect(crashing.delete(pid, created.id)).rejects.toThrow('bucket unavailable');

			await expect(store.get(pid, created.id)).rejects.toThrow(NotFoundError);
			expect(await store.list(pid)).toEqual([]);
			expect(await store.resolveForSession(pid, renderContext(createSessionId()))).toBeUndefined();
			await expect(store.update(pid, created.id, { enabled: false }, ACTOR)).rejects.toThrow(
				NotFoundError,
			);

			await store.delete(pid, created.id);
			expect(
				(await bucket.list({ prefix: `projects/${pid}/integrations/${created.id}/` })).objects,
			).toEqual([]);
			await store.create(pid, { kind: 'echo', name: 'prod', config: { token: 't' } }, ACTOR);
		});
	});

	it('listVersions pages newest-first and reads only the requested page', async () => {
		const versionReads: string[] = [];
		const counting: Bucket = {
			get: (key) => {
				if (key.includes('/versions/')) versionReads.push(key);
				return bucket.get(key);
			},
			head: (key) => bucket.head(key),
			delete: (key) => bucket.delete(key),
			list: (options) => bucket.list(options),
			put: (key, value, options) => bucket.put(key, value, options),
		};
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const store = new ProjectIntegrationsStore({ bucket: counting, registry, codec });
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		for (const greeting of ['a', 'b', 'c']) {
			await store.update(
				pid,
				created.id,
				{ config: { greeting, token: { $secret: { set: true } } } },
				ACTOR,
			);
		}

		versionReads.length = 0;
		const first = await store.listVersions(pid, created.id, { limit: 2 });
		expect(first.items.map((v) => v.version)).toEqual([4, 3]);
		expect(first.next_cursor).not.toBeNull();
		// The whole history is 4 records; a 2-record page must cost 2 reads.
		expect(versionReads).toHaveLength(2);

		const rest = await store.listVersions(pid, created.id, {
			limit: 2,
			cursor: first.next_cursor ?? undefined,
		});
		expect(rest.items.map((v) => v.version)).toEqual([2, 1]);
		expect(rest.next_cursor).toBeNull();

		await expect(
			store.listVersions(pid, created.id, { limit: 2, cursor: 'not a cursor' }),
		).rejects.toThrow(BadRequestError);
	});

	describe('version history paging cost', () => {
		/**
		 * Writes `total` version records directly (cloning the real first one) and
		 * points the head at them — a long history without paying for `total` updates.
		 */
		async function withHistory(total: number) {
			const store = makeStore(bucket);
			const created = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			const integrationPaths = paths.project(pid).integration(created.id);
			const first = await (
				await bucket.get(integrationPaths.version(1))
			)?.json<Record<string, unknown>>();
			for (let version = 2; version <= total; version++) {
				await bucket.put(integrationPaths.version(version), JSON.stringify({ ...first, version }));
			}
			const head = await (await bucket.get(integrationPaths.head))?.json<Record<string, unknown>>();
			await bucket.put(integrationPaths.head, JSON.stringify({ ...head, current_version: total }));
			return { id: created.id, integrationPaths };
		}

		function countingStore() {
			const gets: string[] = [];
			const lists: unknown[] = [];
			const counting: Bucket = {
				get: (key) => {
					gets.push(key);
					return bucket.get(key);
				},
				head: (key) => bucket.head(key),
				delete: (key) => bucket.delete(key),
				list: (options) => {
					lists.push(options);
					return bucket.list(options);
				},
				put: (key, value, options) => bucket.put(key, value, options),
			};
			const registry = new IntegrationRegistry();
			registry.register(echoKind);
			return {
				gets,
				lists,
				store: new ProjectIntegrationsStore({ bucket: counting, registry, codec }),
			};
		}

		it('reads one head + one record per item and never lists the history', async () => {
			const { id } = await withHistory(400);
			const { store, gets, lists } = countingStore();

			const first = await store.listVersions(pid, id, { limit: 2 });
			expect(first.items.map((v) => v.version)).toEqual([400, 399]);
			// The page is COMPUTED from the head pointer: one head read, one read per
			// returned record, and no listing of the 400-record history.
			expect(lists).toEqual([]);
			expect(gets).toHaveLength(3);

			gets.length = 0;
			const rest = await store.listVersions(pid, id, {
				limit: 2,
				cursor: first.next_cursor ?? undefined,
			});
			expect(rest.items.map((v) => v.version)).toEqual([398, 397]);
			expect(rest.next_cursor).not.toBeNull();
			expect(lists).toEqual([]);
			expect(gets).toHaveLength(3);
		});

		/**
		 * A cursor above the head used to yield an empty page WITH a cursor: no
		 * progress toward version 1, `VERSION_PROBE_SLACK` reads burned per
		 * round-trip, and — for a value past 2^53, where `- 1` is a no-op — a cursor
		 * that re-encoded to itself, i.e. a genuinely non-terminating follow loop.
		 */
		it('rejects a forged out-of-range cursor instead of paging empty forever', async () => {
			const { id } = await withHistory(5);
			const { store, gets } = countingStore();
			for (const forged of [
				'1000000000',
				String(Number.MAX_SAFE_INTEGER),
				'9007199254740994', // past 2^53: decrementing it does nothing
				'1e300',
				'1e+300', // the shape `encodeVersionCursor` would round-trip
			]) {
				gets.length = 0;
				await expect(
					store.listVersions(pid, id, { limit: 2, cursor: btoa(forged) }),
					forged,
				).rejects.toThrow(BadRequestError);
				// Rejected before any version record is probed: one head read, no more.
				expect(gets, forged).toHaveLength(1);
			}
		});

		// The highest cursor the store can mint: resumes just under the head.
		it('accepts a cursor at the head and terminates', async () => {
			const { id } = await withHistory(3);
			const { store } = countingStore();

			const page = await store.listVersions(pid, id, { limit: 5, cursor: btoa('3') });
			expect(page.items.map((v) => v.version)).toEqual([2, 1]);
			expect(page.next_cursor).toBeNull();
		});

		it('every cursor it hands out walks the whole history down to version 1', async () => {
			const { id } = await withHistory(7);
			const { store } = countingStore();

			const seen: number[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 10; page++) {
				const result = await store.listVersions(pid, id, { limit: 2, cursor });
				seen.push(...result.items.map((v) => v.version));
				if (result.next_cursor === null) break;
				cursor = result.next_cursor;
			}
			expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
		});

		it('skips a missing record rather than returning a short page', async () => {
			const { id, integrationPaths } = await withHistory(5);
			await bucket.delete(integrationPaths.version(4));
			const { store } = countingStore();

			const first = await store.listVersions(pid, id, { limit: 2 });
			expect(first.items.map((v) => v.version)).toEqual([5, 3]);
			const rest = await store.listVersions(pid, id, {
				limit: 2,
				cursor: first.next_cursor ?? undefined,
			});
			expect(rest.items.map((v) => v.version)).toEqual([2, 1]);
			expect(rest.next_cursor).toBeNull();
		});
	});

	it('rejects a stale If-Match token when consecutive writes share a timestamp', async () => {
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const frozen = '2025-01-01T00:00:00.000Z';
		const store = new ProjectIntegrationsStore({
			bucket,
			registry,
			codec,
			probe: stubProbe,
			now: () => frozen,
		});
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		await store.update(pid, created.id, { enabled: false }, ACTOR, created.updated_at);
		await expect(
			store.update(pid, created.id, { enabled: true }, ACTOR, created.updated_at),
		).rejects.toThrow(PreconditionFailedError);
	});

	it('rejects a head whose project id does not match its storage path', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const key = paths.project(pid).integration(created.id).head;
		const head = await (await bucket.get(key))?.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...head, project_id: createProjectId() }));

		await expect(store.get(pid, created.id)).rejects.toThrow(ValidationError);
	});

	it('rejects version metadata that disagrees with its key or head kind', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const key = paths.project(pid).integration(created.id).version(1);
		const version = await (await bucket.get(key))?.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...version, version: 99, kind: 'other' }));

		await expect(store.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
			ValidationError,
		);
	});

	it('rejects a version record whose ENVELOPE schema_version is newer than this deployment', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const key = paths.project(pid).integration(created.id).version(1);
		const record = await (await bucket.get(key))?.json<Record<string, unknown>>();
		await bucket.put(key, JSON.stringify({ ...record, schema_version: 99 }));

		await expect(store.get(pid, created.id)).rejects.toThrow(/newer deployment/);
		await expect(store.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
			/newer deployment/,
		);
	});

	it('rejects a stored config holding a secret box at an unregistered path', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const key = paths.project(pid).integration(created.id).version(1);
		const record = await (await bucket.get(key))?.json<{ config: Record<string, unknown> }>();
		record!.config.legacy_password = {
			$secret: {
				kind: 'managed',
				envelope: { kek_id: 'k', alg: 'A256GCM', iv: '', ciphertext: '' },
			},
		};
		await bucket.put(key, JSON.stringify(record));

		await expect(store.get(pid, created.id)).rejects.toThrow(/unregistered path/);
		await expect(store.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
			/unregistered path/,
		);
	});

	it('get fails closed on a corrupt envelope at a registered secret path', async () => {
		const store = makeStore(bucket);
		const created = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 't' } },
			ACTOR,
		);
		const key = paths.project(pid).integration(created.id).version(1);
		const record = await (await bucket.get(key))?.json<{ config: Record<string, unknown> }>();
		record!.config.token = {
			$secret: { kind: 'managed', envelope: { kek_id: 'k' } },
		};
		await bucket.put(key, JSON.stringify(record));

		await expect(store.get(pid, created.id)).rejects.toThrow(ValidationError);
		await expect(store.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
			ValidationError,
		);
	});

	it('binds encrypted values to their integration and project context', async () => {
		const store = makeStore(bucket);
		const first = await store.create(
			pid,
			{ kind: 'echo', name: 'first', config: { token: 'first-secret' } },
			ACTOR,
		);
		const second = await store.create(
			pid,
			{ kind: 'echo', name: 'second', config: { token: 'second-secret' } },
			ACTOR,
		);
		const firstKey = paths.project(pid).integration(first.id).version(1);
		const secondKey = paths.project(pid).integration(second.id).version(1);
		const firstVersion = await (
			await bucket.get(firstKey)
		)?.json<{
			config: Record<string, unknown>;
		}>();
		const secondVersion = await (
			await bucket.get(secondKey)
		)?.json<{
			config: Record<string, unknown>;
		}>();
		secondVersion!.config.token = firstVersion!.config.token;
		await bucket.put(secondKey, JSON.stringify(secondVersion));

		await expect(store.resolveForSession(pid, renderContext(createSessionId()))).rejects.toThrow(
			ValidationError,
		);
	});

	it('keeps integration names isolated between projects', async () => {
		const store = makeStore(bucket);
		const other = createProjectId();
		const first = await store.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 'a' } },
			ACTOR,
		);
		const second = await store.create(
			other,
			{ kind: 'echo', name: 'prod', config: { token: 'b' } },
			ACTOR,
		);
		await store.delete(pid, first.id);
		expect((await store.get(other, second.id)).name).toBe('prod');
		await store.create(pid, { kind: 'echo', name: 'prod', config: { token: 'c' } }, ACTOR);
	});

	describe('copy between projects', () => {
		it('re-seals secrets for the destination: the copy outlives the source', async () => {
			const store = makeStore(bucket);
			const target = createProjectId();
			const source = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { greeting: 'hello', token: 'sekret' } },
				ACTOR,
			);
			await store.update(pid, source.id, { config: { greeting: 'v2', token: 'sekret' } }, ACTOR);

			const copy = await store.copy(pid, source.id, target, {}, ACTOR);
			expect(copy.id).not.toBe(source.id);
			expect(copy).toMatchObject({
				name: 'prod',
				enabled: true,
				// The current config lands as a fresh history, not the source's numbering.
				current_version: 1,
				config: { greeting: 'v2', token: { $secret: { set: true } } },
			});
			expect(copy.change_note).toContain(`from project ${pid}`);
			// Plaintext still never reaches the bucket.
			for (const object of (await bucket.list({})).objects) {
				const body = await bucket.get(object.key);
				expect(await body?.text(), object.key).not.toContain('sekret');
			}

			// Deleting the source must not break the copy — a byte-copied envelope
			// (bound to the source head path) would have.
			await store.delete(pid, source.id);
			const render = await store.resolveForSession(target, renderContext(createSessionId()));
			expect(render?.vars.ECHO_PROD_TOKEN).toBe('sekret');
			expect(render?.vars.ECHO_PROD_GREETING).toBe('v2');
		});

		it('preserves external references without resolving them during copy', async () => {
			const resolve = vi.fn(vaultResolver.resolve);
			const store = makeStore(bucket, true, [{ ...vaultResolver, resolve }]);
			const target = createProjectId();
			const source = await store.create(
				pid,
				{
					kind: 'echo',
					name: 'prod',
					config: {
						token: {
							$secret: { kind: 'reference', backend: 'vault', locator: 'apps/prod#token' },
						},
					},
				},
				ACTOR,
			);
			const copy = await store.copy(pid, source.id, target, {}, ACTOR);
			expect(resolve).not.toHaveBeenCalled();
			expect(copy.config.token).toEqual({
				$secret: { kind: 'reference', backend: 'vault', locator: 'apps/prod#token' },
			});
			const rendered = await store.resolveForSession(target, renderContext(createSessionId()));
			expect(rendered?.vars.ECHO_PROD_TOKEN).toBe('resolved:apps/prod#token');
		});

		it('honors a rename and rejects a name already taken in the destination', async () => {
			const store = makeStore(bucket);
			const target = createProjectId();
			const source = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			await store.create(target, { kind: 'echo', name: 'prod', config: { token: 'x' } }, ACTOR);

			await expect(store.copy(pid, source.id, target, {}, ACTOR)).rejects.toThrow(
				/already exists in this project/,
			);
			const renamed = await store.copy(pid, source.id, target, { name: 'prod-copy' }, ACTOR);
			expect(renamed.name).toBe('prod-copy');
		});

		it('404s on an unknown source and fails without a codec for secret configs', async () => {
			const store = makeStore(bucket);
			const target = createProjectId();
			await expect(
				store.copy(pid, 'intg-0000000000000000' as never, target, {}, ACTOR),
			).rejects.toThrow(NotFoundError);

			const source = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { token: 't' } },
				ACTOR,
			);
			await expect(
				makeStore(bucket, false).copy(pid, source.id, target, {}, ACTOR),
			).rejects.toThrow(/MARIMOHUB_SECRETS_KEK/);
		});

		it('the copy and the source evolve independently', async () => {
			const store = makeStore(bucket);
			const target = createProjectId();
			const source = await store.create(
				pid,
				{ kind: 'echo', name: 'prod', config: { greeting: 'a', token: 't' } },
				ACTOR,
			);
			const copy = await store.copy(pid, source.id, target, {}, ACTOR);

			await store.update(
				pid,
				source.id,
				{ config: { greeting: 'source-edit', token: 't' } },
				ACTOR,
			);
			expect((await store.get(target, copy.id)).config.greeting).toBe('a');
			await store.update(target, copy.id, { config: { greeting: 'copy-edit', token: 't' } }, ACTOR);
			expect((await store.get(pid, source.id)).config.greeting).toBe('source-edit');
		});
	});

	it('listKinds describes the default registry serializably', () => {
		const store = new ProjectIntegrationsStore({ bucket, registry: defaultRegistry(), codec });
		const kinds = store.listKinds();
		expect(kinds.map((k) => k.kind).sort()).toEqual([
			'athena',
			'azure_blob',
			'bigquery',
			'clickhouse',
			'custom_env',
			'databricks',
			'gcs',
			'huggingface',
			'iceberg_bigquery',
			'iceberg_dynamodb',
			'iceberg_glue',
			'iceberg_hive',
			'iceberg_rest',
			'iceberg_sql',
			'mongodb',
			'motherduck',
			'mysql',
			'postgres',
			'pyspark',
			'redshift',
			's3',
			'snowflake',
			'sqlserver',
			'trino',
			'wandb',
		]);
		for (const kind of kinds) {
			expect(kind.json_schema).toMatchObject({ type: 'object' });
			expect(() => JSON.stringify(kind)).not.toThrow();
		}
	});
});

describe('OrgIntegrationsStore + project inheritance', () => {
	let bucket: MemoryBucket;
	let pid: ProjectId;
	let org: OrgIntegrationsStore;
	let project: ProjectIntegrationsStore;

	beforeEach(() => {
		bucket = new MemoryBucket();
		pid = createProjectId();
		const registry = new IntegrationRegistry();
		registry.register(echoKind);
		const options = { bucket, registry, codec, probe: stubProbe };
		org = new OrgIntegrationsStore(options);
		project = new ProjectIntegrationsStore(options);
	});

	it('stores org instances under _system/integrations/ with no project_id', async () => {
		const detail = await org.create(
			{ kind: 'echo', name: 'warehouse', config: { token: 'sekret' } },
			ACTOR,
		);
		expect(detail.scope).toBe('org');
		expect(detail.config).toMatchObject({ token: { $secret: { set: true } } });

		const head = await bucket.get(paths.orgIntegration(detail.id).head);
		expect(head).not.toBeNull();
		expect(await head?.json()).not.toHaveProperty('project_id');
		expect(await bucket.head(paths.orgIntegrationNameClaim('warehouse'))).toBeTruthy();
		// Plaintext must never reach any bucket object.
		for (const object of (await bucket.list({})).objects) {
			const body = await bucket.get(object.key);
			expect(await body?.text(), object.key).not.toContain('sekret');
		}
	});

	it('org CRUD round-trips: update appends a version, delete frees the name', async () => {
		const created = await org.create(
			{ kind: 'echo', name: 'warehouse', config: { token: 'one' } },
			ACTOR,
		);
		const updated = await org.update(
			created.id,
			{ config: { greeting: 'hello', token: 'two' }, change_note: 'rotate' },
			ACTOR,
		);
		expect(updated.current_version).toBe(2);
		expect((await org.listVersions(created.id)).items.map((v) => v.version)).toEqual([2, 1]);

		await org.delete(created.id);
		await expect(org.get(created.id)).rejects.toThrow(NotFoundError);
		await org.create({ kind: 'echo', name: 'warehouse', config: { token: 'three' } }, ACTOR);
	});

	it('org names are claimed independently of project names', async () => {
		await org.create({ kind: 'echo', name: 'prod', config: { token: 'o' } }, ACTOR);
		// Same name in a project is allowed — that is the shadowing override.
		await project.create(pid, { kind: 'echo', name: 'prod', config: { token: 'p' } }, ACTOR);
		await expect(
			org.create({ kind: 'echo', name: 'prod', config: { token: 'x' } }, ACTOR),
		).rejects.toThrow(/already exists at the org level/);
	});

	it('project list appends inherited org entries, marking shadowed names', async () => {
		await org.create({ kind: 'echo', name: 'shared', config: { token: 'o' } }, ACTOR);
		await org.create({ kind: 'echo', name: 'aaa', config: { token: 'o' } }, ACTOR);
		await project.create(pid, { kind: 'echo', name: 'shared', config: { token: 'p' } }, ACTOR);

		const entries = await project.list(pid);
		expect(entries.map((e) => ({ name: e.name, scope: e.scope, shadowed: e.shadowed }))).toEqual([
			{ name: 'aaa', scope: 'org', shadowed: undefined },
			{ name: 'shared', scope: 'project', shadowed: undefined },
			{ name: 'shared', scope: 'org', shadowed: true },
		]);
	});

	it('a disabled project instance still shadows in listings — matching what renders', async () => {
		await org.create({ kind: 'echo', name: 'shared', config: { token: 'o' } }, ACTOR);
		const override = await project.create(
			pid,
			{ kind: 'echo', name: 'shared', config: { token: 'p' } },
			ACTOR,
		);
		await project.update(pid, override.id, { enabled: false }, ACTOR);

		const entries = await project.list(pid);
		expect(
			entries.map((e) => ({ scope: e.scope, enabled: e.enabled, shadowed: e.shadowed })),
		).toEqual([
			{ scope: 'project', enabled: false, shadowed: undefined },
			{ scope: 'org', enabled: true, shadowed: true },
		]);
	});

	it('resolveForSession renders org instances into the project session', async () => {
		await org.create({ kind: 'echo', name: 'warehouse', config: { token: 'org-tok' } }, ACTOR);
		await project.create(pid, { kind: 'echo', name: 'db', config: { token: 'proj-tok' } }, ACTOR);

		const sessionId = createSessionId();
		const render = await project.resolveForSession(pid, renderContext(sessionId));
		expect(render?.vars.ECHO_WAREHOUSE_TOKEN).toBe('org-tok');
		expect(render?.vars.ECHO_DB_TOKEN).toBe('proj-tok');
		expect(render?.attachments.map((a) => a.name)).toEqual(['db', 'warehouse']);

		const manifest = render?.files.find((f) => f.path === `${INTEGRATIONS_DIR}/manifest.json`);
		expect(JSON.parse(manifest?.content ?? '')).toMatchObject({
			integrations: [{ name: 'db' }, { name: 'warehouse' }],
		});
	});

	it('a same-name project instance shadows the org one — enabled overrides, disabled opts out', async () => {
		await org.create({ kind: 'echo', name: 'warehouse', config: { token: 'org-tok' } }, ACTOR);
		const override = await project.create(
			pid,
			{ kind: 'echo', name: 'warehouse', config: { token: 'proj-tok' } },
			ACTOR,
		);

		let render = await project.resolveForSession(pid, renderContext(createSessionId()));
		expect(render?.vars.ECHO_WAREHOUSE_TOKEN).toBe('proj-tok');
		expect(render?.attachments).toHaveLength(1);

		// Disabling the override does NOT resurrect the org instance: the
		// same-name project instance is the opt-out.
		await project.update(pid, override.id, { enabled: false }, ACTOR);
		render = await project.resolveForSession(pid, renderContext(createSessionId()));
		expect(render).toBeUndefined();

		// Other projects are unaffected.
		const other = createProjectId();
		render = await project.resolveForSession(other, renderContext(createSessionId()));
		expect(render?.vars.ECHO_WAREHOUSE_TOKEN).toBe('org-tok');
	});

	it('disabled org instances are skipped everywhere', async () => {
		const created = await org.create(
			{ kind: 'echo', name: 'warehouse', config: { token: 'o' } },
			ACTOR,
		);
		await org.update(created.id, { enabled: false }, ACTOR);
		expect(await project.resolveForSession(pid, renderContext(createSessionId()))).toBeUndefined();
		expect((await project.list(pid)).map((e) => e.enabled)).toEqual([false]);
	});

	it('the project tier cannot reach an org instance by id', async () => {
		const created = await org.create(
			{ kind: 'echo', name: 'warehouse', config: { token: 'o' } },
			ACTOR,
		);
		await expect(project.get(pid, created.id)).rejects.toThrow(NotFoundError);
		// Idempotent success, but reported as a no-op — the org instance survives.
		await expect(project.delete(pid, created.id)).resolves.toBe(false);
		expect((await org.get(created.id)).name).toBe('warehouse');
	});

	it('a project head cannot be smuggled into the org tier', async () => {
		const created = await project.create(
			pid,
			{ kind: 'echo', name: 'prod', config: { token: 'p' } },
			ACTOR,
		);
		const head = await bucket.get(paths.project(pid).integration(created.id).head);
		await bucket.put(paths.orgIntegration(created.id).head, (await head?.text()) ?? '');
		await expect(org.get(created.id)).rejects.toThrow(/does not match its storage path/);
	});
});
